import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { createGateway, type Gateway } from "../src/server.js";
import type { Config } from "../src/config.js";
import { parseConfig } from "../src/config.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

function baseConfig(over: Partial<Config>): Config {
  return {
    ...parseConfig(["--detection", "regex", "--upstream", "http://127.0.0.1:9"]),
    ...over,
  };
}

describe("integration mock upstream", () => {
  let upstream: Server;
  let upstreamPort: number;
  let lastUpstream: {
    method?: string;
    path?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: string;
  } = { headers: {} };
  let gateway: Gateway;
  let gwPort: number;
  let detector: Server;
  let detectorPort: number;
  let detectorHits = 0;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastUpstream = {
          method: req.method,
          path: req.url,
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString("utf8"),
        };
        const ct = String(req.headers["content-type"] ?? "");
        if (ct.includes("json") && lastUpstream.body) {
          const incoming = JSON.parse(lastUpstream.body) as {
            messages?: Array<{ content?: string }>;
            stream?: boolean;
          };
          const userText = incoming.messages?.[0]?.content ?? "";
          if (incoming.stream) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const reply = `Got: ${userText}`;
            for (const ch of reply) {
              res.write(
                `data: ${JSON.stringify({ choices: [{ delta: { content: ch }, index: 0 }] })}\n\n`,
              );
            }
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: `Echo: ${userText}` } }],
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    upstreamPort = await listen(upstream);

    detector = createServer((req, res) => {
      detectorHits++;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"entities":[]}' } }],
          }),
        );
      });
    });
    detectorPort = await listen(detector);

    gateway = createGateway(
      baseConfig({
        upstream: `http://127.0.0.1:${upstreamPort}/v1`,
        detection: "regex",
        detectorBaseUrl: `http://127.0.0.1:${detectorPort}/v1`,
      }),
      { log: () => {} },
    );
    gwPort = await listen(gateway.server);
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((r) => upstream.close(() => r()));
    await new Promise<void>((r) => detector.close(() => r()));
  });

  test("OpenAI shape: upstream never sees real email, client gets it back", async () => {
    const real = "alice@example.com";
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-user-secret",
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: `Write to ${real}` }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-pii-masked")).not.toBeNull();
    expect(Number(res.headers.get("x-pii-masked"))).toBeGreaterThan(0);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toContain(real);
    expect(lastUpstream.body).toBeDefined();
    expect(lastUpstream.body!).not.toContain(real);
    expect(lastUpstream.headers.authorization).toBe("Bearer sk-user-secret");
    expect(lastUpstream.path).toBe("/v1/chat/completions");
  });

  test("Anthropic shape with x-api-key", async () => {
    // Remap gateway upstream to same mock — Anthropic path
    const real = "CH93 0076 2011 6238 5295 7";
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "ant-secret",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude",
        messages: [{ role: "user", content: `IBAN ${real}` }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstream.headers["x-api-key"]).toBe("ant-secret");
    expect(lastUpstream.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastUpstream.body!).not.toContain(real);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toContain(real);
  });

  test("streaming OpenAI restores real values", async () => {
    const real = "bob@corp.test";
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-stream",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: `Hi ${real}` }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(lastUpstream.body!).not.toContain(real);
    expect(text).toContain(real);
  });

  test("415 for non-JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: "Bearer x" },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });

  test("400 for malformed JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
    expect(lastUpstream.body).not.toBe("{bad");
  });

  test("preview then chat reuses the same fakes", async () => {
    const real = "alice@example.com";
    const session = "sess-preview-1";
    const before = lastUpstream.body;
    const preview = await fetch(`http://127.0.0.1:${gwPort}/_gateway/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pii-session": session,
      },
      body: JSON.stringify({ text: `Email ${real} please` }),
    });
    expect(preview.status).toBe(200);
    expect(lastUpstream.body).toBe(before);
    const body = (await preview.json()) as {
      masked: { text: string };
      replacements: Array<{ type: string; real: string; fake: string; source: string }>;
    };
    const hit = body.replacements.find((r) => r.real === real);
    expect(hit?.type).toBe("email");
    expect(hit?.source).toBe("regex");
    expect(hit?.fake).toBeTruthy();
    expect(body.masked.text).toContain(hit!.fake);
    expect(body.masked.text).not.toContain(real);

    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-preview",
        "x-pii-session": session,
      },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: `Email ${real} please` }],
      }),
    });
    expect(res.status).toBe(200);
    expect(lastUpstream.body).toContain(hit!.fake);
    expect(lastUpstream.body).not.toContain(real);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toContain(real);
  });

  test("health endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/_gateway/health`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test("detector-swap: DETECTOR_BASE_URL is what gateway calls", async () => {
    detectorHits = 0;
    const gw2 = createGateway(
      baseConfig({
        upstream: `http://127.0.0.1:${upstreamPort}/v1`,
        detection: "llm+regex",
        detectorBaseUrl: `http://127.0.0.1:${detectorPort}/v1`,
        detectorApiKey: "det",
        onDetectorError: "block",
      }),
      { log: () => {} },
    );
    const p = await listen(gw2.server);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk",
        },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hello alice@x.com" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(detectorHits).toBeGreaterThan(0);
    } finally {
      await gw2.close();
    }
  });

  test("ON_DETECTOR_ERROR block returns 502", async () => {
    const deadDet = createServer((_req, res) => {
      res.writeHead(500);
      res.end("fail");
    });
    const dp = await listen(deadDet);
    const gw2 = createGateway(
      baseConfig({
        upstream: `http://127.0.0.1:${upstreamPort}/v1`,
        detection: "llm+regex",
        detectorBaseUrl: `http://127.0.0.1:${dp}/v1`,
        onDetectorError: "block",
      }),
      { log: () => {} },
    );
    const p = await listen(gw2.server);
    try {
      const before = lastUpstream.body;
      const res = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk",
        },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "secret alice@x.com" }],
        }),
      });
      expect(res.status).toBe(502);
      const j = (await res.json()) as { error: { type: string } };
      expect(j.error.type).toBe("pii_detection_failed");
      // nothing forwarded — body unchanged from previous or not containing secret if somehow
      expect(lastUpstream.body === before || !lastUpstream.body?.includes("alice@x.com")).toBe(true);
    } finally {
      await gw2.close();
      await new Promise<void>((r) => deadDet.close(() => r()));
    }
  });
});
