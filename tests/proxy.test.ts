import { describe, expect, test } from "bun:test";
import { buildUpstreamUrl } from "../src/proxy/forward.js";
import { copyRequestHeaders } from "../src/proxy/headers.js";

describe("buildUpstreamUrl", () => {
  test("joins path onto base", () => {
    expect(buildUpstreamUrl("https://api.openai.com/v1", "/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  test("does not double /v1", () => {
    expect(buildUpstreamUrl("https://api.openai.com/v1", "/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  test("does not double /v1 on a longer base path", () => {
    expect(
      buildUpstreamUrl(
        "https://api.swisscom.com/products/swiss-ai-weeks/apertus-1.5-70b/v1",
        "/v1/chat/completions",
      ),
    ).toBe(
      "https://api.swisscom.com/products/swiss-ai-weeks/apertus-1.5-70b/v1/chat/completions",
    );
  });

  test("preserves query", () => {
    expect(buildUpstreamUrl("https://api.example.com", "/x?y=1")).toBe(
      "https://api.example.com/x?y=1",
    );
  });
});

describe("copyRequestHeaders", () => {
  test("strips hop-by-hop and gateway headers, forces identity", () => {
    const out = copyRequestHeaders({
      host: "localhost",
      authorization: "Bearer sk-test",
      "content-length": "10",
      "accept-encoding": "gzip",
      "x-pii-session": "abc",
      "x-upstream-base-url": "https://evil",
      "content-type": "application/json",
    });
    expect(out.authorization).toBe("Bearer sk-test");
    expect(out["content-type"]).toBe("application/json");
    expect(out["accept-encoding"]).toBe("identity");
    expect(out.host).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["x-pii-session"]).toBeUndefined();
    expect(out["x-upstream-base-url"]).toBeUndefined();
  });
});
