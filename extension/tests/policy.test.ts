import { describe, expect, test } from "bun:test";
import { SessionMap } from "../../src/mask/map.js";
import type { Detection } from "../../src/detect/types.js";
import { filterByType, maskDraft } from "../src/policy.js";
import { defaultSettings, ENTITY_TYPES, TYPE_GROUPS } from "../src/settings.js";

function det(over: Partial<Detection> & Pick<Detection, "type" | "value" | "start" | "end">): Detection {
  return { source: "regex", ...over };
}

describe("settings groups", () => {
  test("every entity type is in exactly one group", () => {
    const seen = TYPE_GROUPS.flatMap((g) => g.types);
    expect(seen.slice().sort()).toEqual(ENTITY_TYPES.slice().sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("url and uuid start off", () => {
    const settings = defaultSettings();
    expect(settings.types.url).toBe(false);
    expect(settings.types.uuid).toBe(false);
    expect(settings.types.email).toBe(true);
    expect(settings.enabled).toBe(true);
    expect(settings.onDetectorError).toBe("block");
  });
});

describe("maskDraft", () => {
  test("drops disabled types", () => {
    const settings = defaultSettings();
    settings.types.email = false;
    const text = "ada@example.com";
    const regex = [det({ type: "email", value: text, start: 0, end: text.length })];
    expect(filterByType(regex, settings.types)).toEqual([]);
    const map = new SessionMap("s");
    const out = maskDraft({ text, regex, model: [], settings, map });
    expect(out).toEqual({ ok: true, masked: text, count: 0 });
  });

  test("model failure blocks unless regex fallback is on", () => {
    const settings = defaultSettings();
    const text = "Ada Lovelace";
    const regex: Detection[] = [];
    const blocked = maskDraft({ text, regex, model: "failed", settings, map: new SessionMap("a") });
    expect(blocked).toEqual({ ok: false, error: "detector_failed" });

    settings.onDetectorError = "regex";
    const email = "ada@example.com";
    const passed = maskDraft({
      text: email,
      regex: [det({ type: "email", value: email, start: 0, end: email.length })],
      model: "failed",
      settings,
      map: new SessionMap("b"),
    });
    expect(passed.ok).toBe(true);
    if (passed.ok) expect(passed.masked).not.toBe(email);
  });

  test("skips the model when name types are off", () => {
    const settings = defaultSettings();
    for (const t of ["person_name", "organization", "location", "address"] as const) settings.types[t] = false;
    const email = "ada@example.com";
    const out = maskDraft({
      text: email,
      regex: [det({ type: "email", value: email, start: 0, end: email.length })],
      model: "failed",
      settings,
      map: new SessionMap("c"),
    });
    expect(out.ok).toBe(true);
  });

  test("regex wins over an overlapping model span", () => {
    const settings = defaultSettings();
    const text = "ada@example.com";
    const map = new SessionMap("d");
    const out = maskDraft({
      text,
      regex: [det({ type: "email", value: text, start: 0, end: text.length })],
      model: [det({ type: "person_name", value: text, start: 0, end: text.length, source: "llm" })],
      settings,
      map,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.masked.endsWith("@example.com") || out.masked.includes("@")).toBe(true);
    expect(map.maskedTypes()).toEqual(["email"]);
  });

  test("master switch leaves text unchanged", () => {
    const settings = defaultSettings();
    settings.enabled = false;
    const text = "ada@example.com";
    const out = maskDraft({
      text,
      regex: [det({ type: "email", value: text, start: 0, end: text.length })],
      model: [],
      settings,
      map: new SessionMap("e"),
    });
    expect(out).toEqual({ ok: true, masked: text, count: 0 });
  });
});
