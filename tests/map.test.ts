import { describe, expect, test } from "bun:test";
import { SessionMap } from "../src/mask/map.js";
import { createRng, hashSeed } from "../src/mask/rng.js";

describe("rng", () => {
  test("same seed yields same sequence", () => {
    const a = createRng("session-1");
    const b = createRng("session-1");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  test("different seeds diverge", () => {
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
    const a = createRng("a");
    const b = createRng("b");
    expect(a.next()).not.toBe(b.next());
  });
});

describe("SessionMap", () => {
  test("is bijective for repeated masks", () => {
    const map = new SessionMap("s1");
    const f1 = map.mask("email", "Alice@Example.com");
    const f2 = map.mask("email", "alice@example.com"); // normalized
    expect(f1).toBe(f2);
    expect(map.getReal(f1)).toBe("Alice@Example.com");
    expect(map.getFake("email", "alice@example.com")).toBe(f1);
  });

  test("deterministic seeding across maps with same session id", () => {
    const a = new SessionMap("seed-x");
    const b = new SessionMap("seed-x");
    expect(a.mask("person_name", "Marcus Weber")).toBe(b.mask("person_name", "Marcus Weber"));
  });

  test("different sessions produce different fakes", () => {
    const a = new SessionMap("s-a");
    const b = new SessionMap("s-b");
    expect(a.mask("person_name", "Marcus Weber")).not.toBe(b.mask("person_name", "Marcus Weber"));
  });

  test("rejects collision with request values via noteRequestValues", () => {
    const map = new SessionMap("collide");
    // Force many attempts by noting lots of values — at minimum fake !== real
    const real = "test@example.com";
    map.noteRequestValues([real]);
    const fake = map.mask("email", real);
    expect(fake).not.toBe(real);
    expect(map.getReal(fake)).toBe(real);
  });

  test("two distinct reals get distinct fakes", () => {
    const map = new SessionMap("distinct");
    const f1 = map.mask("email", "a@b.com");
    const f2 = map.mask("email", "c@d.com");
    expect(f1).not.toBe(f2);
  });
});
