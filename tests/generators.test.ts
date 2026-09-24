import { describe, expect, test } from "bun:test";
import {
  ahvCheckDigit,
  ahvValid,
  generateFake,
  ibanCheckDigits,
  ibanValid,
  luhnCheckDigit,
  luhnValid,
} from "../src/mask/generators.js";

describe("checksum helpers", () => {
  test("luhn validates known card", () => {
    // Visa test number
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnCheckDigit("411111111111111")).toBe("1");
  });

  test("iban mod-97", () => {
    expect(ibanValid("CH93 0076 2011 6238 5295 7")).toBe(true);
    expect(ibanValid("CH93 0076 2011 6238 5295 8")).toBe(false);
    const check = ibanCheckDigits("CH00762011623852957");
    expect(check).toBe("93");
  });

  test("ahv ean-13", () => {
    // Construct a valid AHV
    const body = "756123456789";
    const d = ahvCheckDigit(body);
    expect(ahvValid(`756.1234.5678.9${d}`)).toBe(true);
    expect(ahvValid("756.1234.5678.90")).toBe(ahvCheckDigit("756123456789") === "0");
  });
});

describe("generateFake", () => {
  test("never equals real for common types", () => {
    const cases: Array<{ type: Parameters<typeof generateFake>[0]["type"]; real: string }> = [
      { type: "email", real: "alice@example.com" },
      { type: "person_name", real: "Marcus Weber" },
      { type: "phone", real: "+41 79 123 45 67" },
      { type: "credit_card", real: "4111-1111-1111-1111" },
      { type: "iban", real: "CH93 0076 2011 6238 5295 7" },
      { type: "ahv", real: "756.1234.5678.97" },
      { type: "ipv4", real: "203.0.113.10" },
      { type: "uuid", real: "550e8400-e29b-41d4-a716-446655440000" },
    ];
    for (const c of cases) {
      const fake = generateFake({ sessionId: "s", real: c.real, type: c.type });
      expect(fake).not.toBe(c.real);
    }
  });

  test("credit card keeps format and valid luhn", () => {
    const real = "4111-1111-1111-1111";
    const fake = generateFake({ sessionId: "cc", real, type: "credit_card" });
    expect(fake).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/);
    expect(luhnValid(fake)).toBe(true);
    expect(fake).not.toBe(real);
  });

  test("iban keeps country and valid mod-97", () => {
    const real = "CH93 0076 2011 6238 5295 7";
    const fake = generateFake({ sessionId: "iban", real, type: "iban" });
    expect(fake.startsWith("CH")).toBe(true);
    expect(ibanValid(fake)).toBe(true);
    expect(fake).not.toBe(real);
  });

  test("ahv format and check digit", () => {
    const real = "756.2345.6789.01";
    // may be invalid real; generator produces valid
    const fake = generateFake({ sessionId: "ahv", real, type: "ahv" });
    expect(fake).toMatch(/^756\.\d{4}\.\d{4}\.\d{2}$/);
    expect(ahvValid(fake)).toBe(true);
  });

  test("name keeps token count", () => {
    const fake = generateFake({ sessionId: "n", real: "Anna Marie Keller", type: "person_name" });
    expect(fake.split(/\s+/).length).toBe(3);
  });

  test("deterministic for same seed inputs", () => {
    const a = generateFake({ sessionId: "x", real: "Alice", type: "person_name", attempt: 0 });
    const b = generateFake({ sessionId: "x", real: "Alice", type: "person_name", attempt: 0 });
    expect(a).toBe(b);
  });

  test("email is at fake domain", () => {
    const fake = generateFake({ sessionId: "e", real: "bob@corp.ch", type: "email" });
    expect(fake).toMatch(/@.+\.(net|test|demo|fake|invalid)$/);
  });

  test("url keeps host", () => {
    const fake = generateFake({
      sessionId: "u",
      real: "https://bank.example/users/marcus?ssn=1",
      type: "url",
    });
    expect(fake.startsWith("https://bank.example/")).toBe(true);
    expect(fake).not.toContain("marcus");
  });
});
