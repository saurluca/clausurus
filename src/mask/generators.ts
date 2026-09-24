import { createRng, type Rng } from "./rng.js";
import type { EntityType } from "../detect/types.js";

const FIRST_NAMES = [
  "Anna",
  "Lukas",
  "Sophie",
  "Noah",
  "Emma",
  "Leon",
  "Mia",
  "Elias",
  "Laura",
  "Jonas",
  "Marie",
  "David",
  "Chloe",
  "Marc",
  "Elena",
  "Thomas",
  "Sarah",
  "Pierre",
  "Giulia",
  "Marco",
  "James",
  "Olivia",
  "William",
  "Ava",
] as const;

const LAST_NAMES = [
  "Müller",
  "Schmidt",
  "Weber",
  "Meier",
  "Schneider",
  "Fischer",
  "Meyer",
  "Keller",
  "Huber",
  "Brunner",
  "Martin",
  "Bernard",
  "Dubois",
  "Rossi",
  "Bianchi",
  "Ferrari",
  "Smith",
  "Johnson",
  "Brown",
  "Garcia",
] as const;

const ORGS = [
  "Helvetia AG",
  "Alpine Systems",
  "Nordwind GmbH",
  "Lakeview Labs",
  "Summit Partners",
  "Rhine Digital",
  "Cascade Health",
  "Matterhorn Soft",
  "Geneva Analytics",
  "Zurich Cloud",
] as const;

const CITIES = [
  "Zürich",
  "Bern",
  "Geneva",
  "Basel",
  "Lausanne",
  "Lucerne",
  "St. Gallen",
  "Lugano",
  "Winterthur",
  "Fribourg",
  "Berlin",
  "Paris",
  "Milan",
  "Vienna",
  "London",
] as const;

const STREETS = [
  "Bahnhofstrasse",
  "Hauptstrasse",
  "Seestrasse",
  "Bergweg",
  "Rue du Lac",
  "Via Roma",
  "Park Lane",
  "Oak Avenue",
  "Kirchgasse",
  "Quai des Alpes",
] as const;

const FAKE_DOMAINS = [
  "example.net",
  "mail.test",
  "inbox.demo",
  "post.fake",
  "letters.invalid",
] as const;

export function luhnCheckDigit(digitsWithoutCheck: string): string {
  let sum = 0;
  let dbl = true;
  for (let i = digitsWithoutCheck.length - 1; i >= 0; i--) {
    let d = digitsWithoutCheck.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 2) return false;
  const body = clean.slice(0, -1);
  return luhnCheckDigit(body) === clean.slice(-1);
}

/** IBAN mod-97 check: rearrange and interpret as integer mod 97 == 1. */
export function ibanValid(iban: string): boolean {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(clean) || clean.length < 15) return false;
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      const n = code - 55; // A=10
      rem = (rem * 100 + n) % 97;
    } else {
      rem = (rem * 10 + (code - 48)) % 97;
    }
  }
  return rem === 1;
}

export function ibanCheckDigits(countryAndBban: string): string {
  // countryAndBban is CC + BBAN (without check digits); we need full with 00 then compute
  const base = (countryAndBban.slice(0, 2) + "00" + countryAndBban.slice(2)).toUpperCase();
  const rearranged = base.slice(4) + base.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      const n = code - 55;
      rem = (rem * 100 + n) % 97;
    } else {
      rem = (rem * 10 + (code - 48)) % 97;
    }
  }
  const check = 98 - rem;
  return String(check).padStart(2, "0");
}

/** AHV/AVS EAN-13 style check digit on 756XXXXXXXXX (12 digits → 13th). */
export function ahvCheckDigit(twelveDigits: string): string {
  const digits = twelveDigits.replace(/\D/g, "");
  if (digits.length !== 12) throw new Error("AHV body must be 12 digits");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

export function ahvValid(ahv: string): boolean {
  const digits = ahv.replace(/\D/g, "");
  if (digits.length !== 13 || !digits.startsWith("756")) return false;
  return ahvCheckDigit(digits.slice(0, 12)) === digits.slice(12);
}

function formatPreserve(template: string, rng: Rng): string {
  let out = "";
  for (const ch of template) {
    if (ch >= "0" && ch <= "9") out += rng.digit();
    else if (ch >= "a" && ch <= "z") out += rng.letter(false);
    else if (ch >= "A" && ch <= "Z") out += rng.letter(true);
    else out += ch;
  }
  return out;
}

function matchCase(sample: string, template: string): string {
  if (template === template.toUpperCase() && /[A-Z]/.test(template)) return sample.toUpperCase();
  if (template === template.toLowerCase() && /[a-z]/.test(template)) return sample.toLowerCase();
  // Title-ish: first letter of each token
  const parts = sample.split(/(\s+)/);
  const tParts = template.split(/(\s+)/);
  return parts
    .map((p, i) => {
      const t = tParts[i] ?? tParts[tParts.length - 1] ?? "";
      if (!/[a-zA-Z]/.test(p)) return p;
      if (t && t[0] === t[0]?.toUpperCase() && t.slice(1) === t.slice(1).toLowerCase()) {
        return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      }
      if (t === t.toUpperCase()) return p.toUpperCase();
      if (t === t.toLowerCase()) return p.toLowerCase();
      return p;
    })
    .join("");
}

function fakeName(real: string, rng: Rng): string {
  const tokens = real.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return rng.pick(FIRST_NAMES);
  const fakes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (i === tokens.length - 1 && tokens.length > 1) {
      fakes.push(matchCase(rng.pick(LAST_NAMES), token));
    } else {
      fakes.push(matchCase(rng.pick(FIRST_NAMES), token));
    }
  }
  return fakes.join(" ");
}

function fakeCreditCard(real: string, rng: Rng): string {
  const digits = real.replace(/\D/g, "");
  const len = Math.max(13, Math.min(19, digits.length || 16));
  const prefixLen = Math.min(6, len - 1);
  let body = "";
  for (let i = 0; i < len - 1; i++) {
    if (i < prefixLen && digits[i]) body += digits[i]!;
    else body += rng.digit();
  }
  // avoid leading zeros looking odd; keep first digit from real if present
  if (body[0] === "0") body = "4" + body.slice(1);
  const check = luhnCheckDigit(body);
  const full = body + check;
  // restore separators from real
  if (!/\D/.test(real)) return full;
  let di = 0;
  let out = "";
  for (const ch of real) {
    if (/\d/.test(ch)) {
      out += full[di++] ?? rng.digit();
    } else out += ch;
  }
  while (di < full.length) out += full[di++];
  return out;
}

function fakeIban(real: string, rng: Rng): string {
  const clean = real.replace(/\s+/g, "").toUpperCase();
  const country = /^[A-Z]{2}/.test(clean) ? clean.slice(0, 2) : "CH";
  const bbanLen = Math.max(12, clean.length - 4);
  let bban = "";
  for (let i = 0; i < bbanLen; i++) {
    const src = clean[4 + i];
    if (src && /[A-Z]/.test(src)) bban += rng.letter(true);
    else bban += rng.digit();
  }
  const check = ibanCheckDigits(country + bban);
  const full = country + check + bban;
  if (!/\s/.test(real)) return full;
  // re-space like original groups of 4
  return full.replace(/(.{4})/g, "$1 ").trim();
}

function fakeAhv(real: string, rng: Rng): string {
  let body = "756";
  for (let i = 0; i < 9; i++) body += rng.digit();
  const check = ahvCheckDigit(body);
  const full = body + check;
  // Format 756.XXXX.XXXX.XX
  const formatted = `${full.slice(0, 3)}.${full.slice(3, 7)}.${full.slice(7, 11)}.${full.slice(11)}`;
  if (real.includes(".")) return formatted;
  return full;
}

function fakeEmail(real: string, rng: Rng): string {
  const at = real.indexOf("@");
  const localLen = at > 0 ? Math.max(3, Math.min(12, at)) : 8;
  let local = "";
  for (let i = 0; i < localLen; i++) {
    local += rng.next() < 0.7 ? rng.letter(false) : rng.digit();
  }
  return `${local}@${rng.pick(FAKE_DOMAINS)}`;
}

function fakePhone(real: string, rng: Rng): string {
  return formatPreserve(real, rng);
}

function fakeIpv4(rng: Rng): string {
  return `${rng.int(223) + 1}.${rng.int(256)}.${rng.int(256)}.${rng.int(254) + 1}`;
}

function fakeIpv6(real: string, rng: Rng): string {
  return formatPreserve(real, rng);
}

function fakeUuid(real: string, rng: Rng): string {
  return formatPreserve(real.toLowerCase(), rng);
}

function fakeUrl(real: string, rng: Rng): string {
  try {
    const u = new URL(real);
    u.pathname = `/p/${rng.int(1e6)}`;
    u.search = `?t=${rng.int(1e6)}`;
    u.hash = "";
    return u.toString();
  } catch {
    return formatPreserve(real, rng);
  }
}

function fakeDob(real: string, rng: Rng): string {
  return formatPreserve(real, rng);
}

function fakeGenericId(real: string, rng: Rng): string {
  return formatPreserve(real, rng);
}

export type GenerateOpts = {
  sessionId: string;
  real: string;
  type: EntityType;
  attempt?: number;
};

export function generateFake(opts: GenerateOpts): string {
  const { sessionId, real, type, attempt = 0 } = opts;
  const rng = createRng(`${sessionId}|${type}|${real}|${attempt}`);
  switch (type) {
    case "person_name":
      return fakeName(real, rng);
    case "organization":
      return matchCase(rng.pick(ORGS), real);
    case "location":
      return matchCase(rng.pick(CITIES), real);
    case "address": {
      const num = 1 + rng.int(200);
      return `${rng.pick(STREETS)} ${num}, ${rng.pick(CITIES)}`;
    }
    case "email":
      return fakeEmail(real, rng);
    case "phone":
      return fakePhone(real, rng);
    case "ipv4":
      return fakeIpv4(rng);
    case "ipv6":
      return fakeIpv6(real, rng);
    case "url":
      return fakeUrl(real, rng);
    case "uuid":
      return fakeUuid(real, rng);
    case "credit_card":
      return fakeCreditCard(real, rng);
    case "iban":
      return fakeIban(real, rng);
    case "ahv":
      return fakeAhv(real, rng);
    case "date_of_birth":
      return fakeDob(real, rng);
    case "medical_record":
    case "insurance_id":
    case "other_id":
    case "passport":
    case "national_id":
    case "driver_license":
    case "id_card":
    case "tracking_number":
      return fakeGenericId(real, rng);
    default:
      return formatPreserve(real, rng);
  }
}
