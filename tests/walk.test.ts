import { describe, expect, test } from "bun:test";
import { collectMaskableStrings, walkStrings } from "../src/mask/walk.js";
import { maskJson, maskText } from "../src/mask/mask.js";
import { unmaskJson, unmaskText } from "../src/mask/unmask.js";
import { SessionMap } from "../src/mask/map.js";
import { detectRegex } from "../src/detect/regex.js";
import type { Detection } from "../src/detect/types.js";

describe("walkStrings", () => {
  test("skips structural keys and schema subtrees", () => {
    const body = {
      model: "gpt-4",
      role: "user",
      messages: [{ role: "user", content: "hi alice@example.com" }],
      tools: [{ name: "x", parameters: { type: "object", email: "secret@x.com" } }],
      tool_choice: "auto",
    };
    const strings = collectMaskableStrings(body);
    expect(strings).toContain("hi alice@example.com");
    expect(strings).not.toContain("gpt-4");
    expect(strings).not.toContain("user");
    expect(strings).not.toContain("secret@x.com");
    expect(strings).not.toContain("auto");
  });

  test("walks JSON-in-string tool arguments", () => {
    const body = {
      messages: [
        {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ email: "bob@corp.com", n: 1 }),
              },
            },
          ],
        },
      ],
    };
    const strings = collectMaskableStrings(body);
    expect(strings).toContain("bob@corp.com");
  });

  test("skips data: URIs and large base64", () => {
    const b64 = "A".repeat(2000);
    const body = {
      url: "data:image/png;base64,abc",
      blob: b64,
      note: "ok",
    };
    const strings = collectMaskableStrings(body);
    expect(strings).toEqual(["ok"]);
  });
});

describe("mask/unmask round trip", () => {
  function roundTrip(fixture: unknown, extraDets: Detection[][] = []): unknown {
    const map = new SessionMap("rt");
    const clone = structuredClone(fixture);
    const strings = collectMaskableStrings(clone);
    const byText = strings.map((s, i) => {
      const regex = detectRegex(s);
      return [...regex, ...(extraDets[i] ?? [])];
    });
    const masked = maskJson(clone, byText, map);
    return unmaskJson(masked, map);
  }

  test("OpenAI chat fixture", () => {
    const fixture = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: "Email alice@example.com and card 4111 1111 1111 1111",
        },
      ],
    };
    const back = roundTrip(fixture) as typeof fixture;
    expect(back.messages[1]!.content).toBe(fixture.messages[1]!.content);
    expect(back.model).toBe("gpt-4o");
  });

  test("Anthropic messages fixture", () => {
    const fixture = {
      model: "claude-3",
      system: "Be brief. Contact support@firm.ch if needed.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "My IBAN is CH93 0076 2011 6238 5295 7" }],
        },
      ],
    };
    const map = new SessionMap("anth");
    const strings = collectMaskableStrings(structuredClone(fixture));
    const byText = strings.map((s) => detectRegex(s));
    const masked = maskJson(structuredClone(fixture), byText, map) as typeof fixture;
    // upstream must not see real IBAN
    const maskedStr = JSON.stringify(masked);
    expect(maskedStr).not.toContain("CH93 0076 2011 6238 5295 7");
    const back = unmaskJson(masked, map) as typeof fixture;
    expect(JSON.stringify(back)).toContain("CH93 0076 2011 6238 5295 7");
  });

  test("Responses API fixture", () => {
    const fixture = {
      model: "gpt-4.1",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Reach me at carol@demo.org" }],
        },
      ],
    };
    const back = roundTrip(fixture) as typeof fixture;
    expect(back.input[0]!.content[0]!.text).toBe("Reach me at carol@demo.org");
  });

  test("maskText + unmaskText", () => {
    const map = new SessionMap("t");
    const text = "mail alice@example.com";
    const dets = detectRegex(text);
    const masked = maskText(text, dets, map);
    expect(masked).not.toContain("alice@example.com");
    expect(unmaskText(masked, map)).toBe(text);
  });

  test("person name case variants on unmask", () => {
    const map = new SessionMap("n");
    const fake = map.mask("person_name", "Marcus Weber");
    const upper = fake.toUpperCase();
    expect(unmaskText(`Hello ${upper}`, map).includes("MARCUS WEBER") || unmaskText(`Hello ${upper}`, map).includes("Marcus Weber")).toBe(true);
  });

  test("does not mutate structural role during walk set", () => {
    const body = { messages: [{ role: "user", content: "x" }] };
    walkStrings(body, (v) => {
      if (v.key === "role") throw new Error("should skip role");
    });
  });
});
