import { describe, expect, test } from "bun:test";
import { detectRegex } from "../src/detect/regex.js";
import { ahvCheckDigit } from "../src/mask/generators.js";

function validAhv(): string {
  const body = "756123456789";
  return `756.1234.5678.9${ahvCheckDigit(body)}`;
}

describe("detectRegex", () => {
  test("email", () => {
    const d = detectRegex("Contact alice.smith@example.com please");
    expect(d.some((x) => x.type === "email" && x.value === "alice.smith@example.com")).toBe(true);
  });

  test("swiss phone", () => {
    const d = detectRegex("Call +41 79 123 45 67 or 079 123 45 67");
    const phones = d.filter((x) => x.type === "phone");
    expect(phones.length).toBeGreaterThanOrEqual(1);
  });

  test("ipv4 and ipv6", () => {
    const d = detectRegex("From 203.0.113.10 and 2001:db8::1");
    expect(d.some((x) => x.type === "ipv4" && x.value === "203.0.113.10")).toBe(true);
    expect(d.some((x) => x.type === "ipv6")).toBe(true);
  });

  test("url with query or personal path", () => {
    const withQ = detectRegex("See https://bank.example/home?user=1");
    expect(withQ.some((x) => x.type === "url")).toBe(true);
    const withPath = detectRegex("See https://bank.example/users/marcus");
    expect(withPath.some((x) => x.type === "url")).toBe(true);
    const plain = detectRegex("See https://example.com/docs");
    expect(plain.some((x) => x.type === "url")).toBe(false);
  });

  test("uuid", () => {
    const d = detectRegex("id=550e8400-e29b-41d4-a716-446655440000");
    expect(d.some((x) => x.type === "uuid")).toBe(true);
  });

  test("credit card with luhn", () => {
    const d = detectRegex("card 4111 1111 1111 1111");
    expect(d.some((x) => x.type === "credit_card")).toBe(true);
    const bad = detectRegex("card 4111 1111 1111 1112");
    expect(bad.some((x) => x.type === "credit_card")).toBe(false);
  });

  test("iban", () => {
    const d = detectRegex("IBAN CH93 0076 2011 6238 5295 7");
    expect(d.some((x) => x.type === "iban")).toBe(true);
  });

  test("ahv", () => {
    const ahv = validAhv();
    const d = detectRegex(`AHV ${ahv}`);
    expect(d.some((x) => x.type === "ahv" && x.value === ahv)).toBe(true);
  });

  test("dates only with DOB context", () => {
    const withCtx = detectRegex("born 15.03.1988 in Bern");
    expect(withCtx.some((x) => x.type === "date_of_birth")).toBe(true);
    const fr = detectRegex("né le 15/03/1988");
    expect(fr.some((x) => x.type === "date_of_birth")).toBe(true);
    const noCtx = detectRegex("meeting on 15.03.1988");
    expect(noCtx.some((x) => x.type === "date_of_birth")).toBe(false);
  });

  test("document ids need a keyword", () => {
    const token = "Z98M3876P";
    expect(detectRegex(`Reisepass: ${token}`).some((x) => x.type === "passport" && x.value === token)).toBe(true);
    expect(detectRegex(`SSN ${token}`).some((x) => x.type === "national_id")).toBe(true);
    expect(detectRegex(`Führerschein ${token}`).some((x) => x.type === "driver_license")).toBe(true);
    expect(detectRegex(`Personalausweis ${token}`).some((x) => x.type === "id_card")).toBe(true);
    expect(detectRegex(`code ${token}`).some((x) => x.type === "passport" || x.type === "national_id" || x.type === "driver_license" || x.type === "id_card")).toBe(false);
  });

  test("tracking numbers use carrier shapes", () => {
    const ups = detectRegex("ship 1Z999AA10123456784 today");
    expect(ups.some((x) => x.type === "tracking_number" && x.value === "1Z999AA10123456784")).toBe(true);
    expect(detectRegex("order 1234567890").some((x) => x.type === "tracking_number")).toBe(false);
  });

  test("returns offsets", () => {
    const text = "mail a@b.co end";
    const d = detectRegex(text);
    const email = d.find((x) => x.type === "email")!;
    expect(text.slice(email.start, email.end)).toBe(email.value);
  });
});
