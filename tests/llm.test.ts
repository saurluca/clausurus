import { describe, expect, test, beforeEach } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  chunkText,
  detectLlm,
  locateEntities,
  resetDetectorEndpointState,
  stripToJsonObject,
  DetectorError,
} from "../src/detect/llm.js";
import {
  clearDetectionCache,
  mergeDetections,
  runDetection,
} from "../src/detect/pipeline.js";
import type { Config } from "../src/config.js";

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    upstream: "http://127.0.0.1:9",
    allowUpstreamOverride: false,
    upstreamAllowlist: [],
    detectorBaseUrl: "http://127.0.0.1:9",
    detectorModel: "test-model",
    detectorApiKey: "det-key",
    detection: "llm+regex",
    onDetectorError: "block",
    port: 8787,
    host: "127.0.0.1",
    sessionTtlSeconds: 3600,
    allowRaw: false,
    inspect: false,
    ...over,
  };
}

function openaiReply(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
  });
}

async function withStub(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => {
  resetDetectorEndpointState();
  clearDetectionCache();
});

describe("llm helpers", () => {
  test("stripToJsonObject", () => {
    expect(stripToJsonObject('Here: {"entities":[]} ok')).toBe('{"entities":[]}');
  });

  test("locateEntities discards hallucinations", () => {
    const text = "Hello Marcus Weber from Bern";
    const d = locateEntities(text, [
      { type: "person_name", value: "Marcus Weber" },
      { type: "person_name", value: "Invented Person" },
      { type: "location", value: "Bern" },
    ]);
    expect(d.map((x) => x.value).sort()).toEqual(["Bern", "Marcus Weber"]);
  });

  test("locateEntities keeps benchmark labels by mapping them", () => {
    const text = "user wynqvrh053 password q4R\\ license LOUMA.657200.9.504";
    const d = locateEntities(text, [
      { type: "USERNAME", value: "wynqvrh053" },
      { type: "PASS", value: "q4R\\" },
      { type: "DRIVERLICENSE", value: "LOUMA.657200.9.504" },
      { type: "not_a_label", value: "user" },
    ]);
    expect(d.map((x) => [x.type, x.value])).toEqual([
      ["person_name", "wynqvrh053"],
      ["other_id", "q4R\\"],
      ["other_id", "LOUMA.657200.9.504"],
    ]);
  });

  test("chunkText splits long input", () => {
    const long = "para\n\n".repeat(2000);
    const chunks = chunkText(long, 6000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(long);
  });
});

describe("detectLlm stub", () => {
  test("parses entities and locates them", async () => {
    await withStub((_req, res, body) => {
      const parsed = JSON.parse(body);
      expect(parsed.temperature).toBe(0);
      expect(parsed.response_format).toEqual({ type: "json_object" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        openaiReply(
          JSON.stringify({
            entities: [{ type: "person_name", value: "Marcus Weber" }],
          }),
        ),
      );
    }, async (baseUrl) => {
      const d = await detectLlm(
        { baseUrl, model: "m", apiKey: "k" },
        "Patient Marcus Weber arrived",
      );
      expect(d).toHaveLength(1);
      expect(d[0]!.value).toBe("Marcus Weber");
      expect(d[0]!.source).toBe("llm");
    });
  });

  test("drops response_format after 400 and retries", async () => {
    let calls = 0;
    await withStub((_req, res, body) => {
      calls++;
      const parsed = JSON.parse(body);
      if (parsed.response_format) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no response_format" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        openaiReply('{"entities":[{"type":"organization","value":"Helvetia"}]}'),
      );
    }, async (baseUrl) => {
      const d = await detectLlm({ baseUrl, model: "m" }, "Visit Helvetia office");
      expect(calls).toBe(2);
      expect(d[0]!.value).toBe("Helvetia");
      calls = 0;
      await detectLlm({ baseUrl, model: "m" }, "Visit Helvetia office again");
      expect(calls).toBe(1);
    });
  });

  test("retries once on malformed JSON then succeeds", async () => {
    let calls = 0;
    await withStub((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      if (calls === 1) {
        res.end(openaiReply("not json at all"));
      } else {
        res.end(openaiReply('{"entities":[{"type":"location","value":"Zürich"}]}'));
      }
    }, async (baseUrl) => {
      const d = await detectLlm({ baseUrl, model: "m" }, "City Zürich nearby");
      expect(calls).toBe(2);
      expect(d[0]!.value).toBe("Zürich");
    });
  });

  test("throws after two parse failures", async () => {
    await withStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(openaiReply("still not json"));
    }, async (baseUrl) => {
      await expect(detectLlm({ baseUrl, model: "m" }, "text")).rejects.toBeInstanceOf(
        DetectorError,
      );
    });
  });
});

describe("mergeDetections", () => {
  test("regex wins over llm on overlap", () => {
    const regex = [
      {
        type: "email" as const,
        value: "a@b.com",
        start: 0,
        end: 7,
        source: "regex" as const,
      },
    ];
    const llm = [
      {
        type: "other_id" as const,
        value: "a@b.com",
        start: 0,
        end: 7,
        source: "llm" as const,
      },
    ];
    const m = mergeDetections(regex, llm);
    expect(m).toHaveLength(1);
    expect(m[0]!.source).toBe("regex");
    expect(m[0]!.type).toBe("email");
  });
});

describe("runDetection", () => {
  test("uses detector base URL from config", async () => {
    let hit = false;
    await withStub((_req, res) => {
      hit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(openaiReply('{"entities":[]}'));
    }, async (baseUrl) => {
      await runDetection({
        config: baseConfig({ detectorBaseUrl: baseUrl }),
        texts: ["hello alice@test.com"],
        bypassCache: true,
      });
      expect(hit).toBe(true);
    });
  });

  test("regex-only mode needs no detector", async () => {
    const r = await runDetection({
      config: baseConfig({ detection: "regex" }),
      texts: ["mail alice@example.com"],
    });
    expect(r.byText[0]!.some((d) => d.type === "email")).toBe(true);
  });

  test("onDetectorError regex falls back", async () => {
    await withStub((_req, res) => {
      res.writeHead(500);
      res.end("fail");
    }, async (baseUrl) => {
      const r = await runDetection({
        config: baseConfig({
          detectorBaseUrl: baseUrl,
          onDetectorError: "regex",
        }),
        texts: ["mail alice@example.com"],
        bypassCache: true,
      });
      expect(r.byText[0]!.some((d) => d.type === "email")).toBe(true);
    });
  });
});
