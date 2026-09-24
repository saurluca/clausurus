import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { DetectorError } from "./detect/llm.js";
import { runDetection } from "./detect/pipeline.js";
import { collectMaskableStrings } from "./mask/walk.js";
import { maskJson } from "./mask/mask.js";
import { unmaskJson, unmaskText } from "./mask/unmask.js";
import { createSseUnmaskTransform } from "./mask/stream.js";
import { SessionStore } from "./session/store.js";
import { buildUpstreamUrl, forwardRequest } from "./proxy/forward.js";
import { copyRequestHeaders, copyResponseHeaders } from "./proxy/headers.js";

export type LogFn = (fields: Record<string, unknown>) => void;

const defaultLog: LogFn = (fields) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function contentType(req: IncomingMessage): string {
  return String(req.headers["content-type"] ?? "").toLowerCase();
}

function isJsonContentType(ct: string): boolean {
  return ct.includes("application/json") || ct.includes("+json");
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function resolveUpstream(config: Config, req: IncomingMessage): string | { error: string } {
  const override = header(req, "x-upstream-base-url");
  if (override) {
    if (!config.allowUpstreamOverride) {
      return { error: "upstream override disabled" };
    }
    const cleaned = override.replace(/\/$/, "");
    if (
      config.upstreamAllowlist.length &&
      !config.upstreamAllowlist.includes(cleaned)
    ) {
      return { error: "upstream not allowlisted" };
    }
    return cleaned;
  }
  if (!config.upstream && !config.inspect) {
    return { error: "no upstream configured" };
  }
  return config.upstream;
}

async function probe(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch {
    return false;
  }
}

export type Gateway = {
  server: Server;
  store: SessionStore;
  close: () => Promise<void>;
};

export function createGateway(config: Config, opts?: { log?: LogFn; fetchFn?: typeof fetch }): Gateway {
  const log = opts?.log ?? defaultLog;
  const fetchFn = opts?.fetchFn ?? fetch;
  const store = new SessionStore(config.sessionTtlSeconds);

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    try {
      if (method === "GET" && url.split("?")[0] === "/_gateway/health") {
        const detectorOk =
          config.detection === "regex"
            ? true
            : await probe(`${config.detectorBaseUrl}/models`);
        const upstreamOk = config.upstream
          ? await probe(config.upstream)
          : config.inspect;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            detector: detectorOk,
            upstream: upstreamOk,
          }),
        );
        return;
      }

      const upstreamBase = resolveUpstream(config, req);
      if (typeof upstreamBase === "object") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "bad_request", message: upstreamBase.error } }));
        return;
      }

      const bodyBuf = method === "GET" || method === "HEAD" || method === "DELETE"
        ? Buffer.alloc(0)
        : await readBody(req);

      const ct = contentType(req);
      let outboundBody: Buffer | string | null = null;
      let map = header(req, "x-pii-session")
        ? store.getOrCreate(header(req, "x-pii-session"))
        : store.fresh();
      let maskedCount = 0;
      let maskedTypes: string[] = [];

      if (bodyBuf.length > 0) {
        if (!isJsonContentType(ct)) {
          if (!config.allowRaw) {
            res.writeHead(415, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { type: "unsupported_media_type", message: "only application/json bodies are masked" },
              }),
            );
            return;
          }
          outboundBody = bodyBuf;
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyBuf.toString("utf8"));
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({ error: { type: "invalid_json", message: "malformed JSON body" } }),
            );
            return;
          }

          const strings = collectMaskableStrings(parsed);
          let byText;
          try {
            const result = await runDetection({
              config,
              texts: strings,
              fetchFn,
            });
            byText = result.byText;
          } catch (err) {
            if (config.onDetectorError === "block" || err instanceof DetectorError) {
              log({
                requestId,
                method,
                path: url.split("?")[0],
                error: "pii_detection_failed",
                latencyMs: Date.now() - started,
              });
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: { type: "pii_detection_failed" } }));
              return;
            }
            throw err;
          }

          const masked = maskJson(parsed, byText, map);
          maskedCount = map.maskedCount();
          maskedTypes = map.maskedTypes();
          outboundBody = JSON.stringify(masked);

          if (config.inspect) {
            console.error("[inspect] upstream body:", outboundBody);
          }
        }
      }

      const pathWithQuery = url;
      const upstreamUrl = buildUpstreamUrl(
        upstreamBase || "http://127.0.0.1:0",
        pathWithQuery,
      );

      // Inspect mode: built-in mock upstream
      if (config.inspect && !config.upstream) {
        await inspectRespond(req, res, outboundBody, map, maskedCount, maskedTypes, requestId, started, method, url, log);
        return;
      }

      const headers = copyRequestHeaders(req.headers);
      if (outboundBody !== null) {
        headers["content-type"] = "application/json";
      }

      let upstream;
      try {
        upstream = await forwardRequest({
          upstreamUrl,
          method,
          headers,
          body: outboundBody,
          fetchFn,
        });
      } catch (err) {
        log({
          requestId,
          method,
          path: url.split("?")[0],
          error: "upstream_unreachable",
          latencyMs: Date.now() - started,
        });
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "upstream_unreachable" } }));
        return;
      }

      const upstreamCt = (upstream.headers.get("content-type") ?? "").toLowerCase();
      const audit = { masked: maskedCount, types: maskedTypes };
      const outHeaders = copyResponseHeaders(upstream.headers, audit);

      log({
        requestId,
        method,
        path: url.split("?")[0],
        entityCount: maskedCount,
        entityTypes: maskedTypes,
        latencyMs: Date.now() - started,
        upstreamStatus: upstream.status,
      });

      if (!upstream.body) {
        res.writeHead(upstream.status, outHeaders);
        res.end();
        return;
      }

      if (upstreamCt.includes("text/event-stream")) {
        res.writeHead(upstream.status, { ...outHeaders, "content-type": "text/event-stream" });
        const transform = createSseUnmaskTransform(map);
        const nodeStream = readableStreamToNode(upstream.body.pipeThrough(transform));
        nodeStream.pipe(res);
        return;
      }

      const buf = Buffer.from(await new Response(upstream.body).arrayBuffer());
      if (upstreamCt.includes("application/json") || upstreamCt.includes("+json")) {
        try {
          const json = JSON.parse(buf.toString("utf8"));
          const unmasked = unmaskJson(json, map);
          const out = Buffer.from(JSON.stringify(unmasked));
          res.writeHead(upstream.status, outHeaders);
          res.end(out);
          return;
        } catch {
          // fall through to text unmask
        }
      }

      if (upstreamCt.startsWith("text/") || upstreamCt.includes("json")) {
        const text = unmaskText(buf.toString("utf8"), map);
        res.writeHead(upstream.status, outHeaders);
        res.end(text);
        return;
      }

      // binary pass-through
      res.writeHead(upstream.status, outHeaders);
      res.end(buf);
    } catch (err) {
      log({
        requestId,
        method,
        path: url.split("?")[0],
        error: "internal",
        latencyMs: Date.now() - started,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error" } }));
      }
      void err;
    }
  }

  return {
    server,
    store,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function inspectRespond(
  req: IncomingMessage,
  res: ServerResponse,
  outboundBody: Buffer | string | null,
  map: import("./mask/map.js").SessionMap,
  maskedCount: number,
  maskedTypes: string[],
  requestId: string,
  started: number,
  method: string,
  url: string,
  log: LogFn,
): Promise<void> {
  // Echo a chat-completions-like response using masked body content
  const received = typeof outboundBody === "string" ? outboundBody : outboundBody?.toString("utf8") ?? "";
  console.error("[inspect] method=", method, "path=", url.split("?")[0]);
  console.error("[inspect] received body:", received);

  const reply = {
    id: "inspect-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `I received: ${received.slice(0, 500)}`,
        },
        finish_reason: "stop",
      },
    ],
  };
  const unmasked = unmaskJson(reply, map);
  const outHeaders = {
    "content-type": "application/json",
    "X-Pii-Masked": String(maskedCount),
    "X-Pii-Types": maskedTypes.join(","),
  };
  log({
    requestId,
    method,
    path: url.split("?")[0],
    entityCount: maskedCount,
    entityTypes: maskedTypes,
    latencyMs: Date.now() - started,
    upstreamStatus: 200,
  });
  res.writeHead(200, outHeaders);
  res.end(JSON.stringify(unmasked));
  void req;
}

function readableStreamToNode(stream: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(stream as unknown as NodeWebReadableStream);
}

export function listen(gateway: Gateway, config: Config): Promise<void> {
  if (config.host === "0.0.0.0") {
    console.warn(
      "WARNING: listening on 0.0.0.0 exposes the privacy gateway on all interfaces. Prefer 127.0.0.1.",
    );
  }
  return new Promise((resolve) => {
    gateway.server.listen(config.port, config.host, () => resolve());
  });
}
