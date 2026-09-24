import type { Detection, EntityType } from "./types.js";
import { ahvValid, ibanValid, luhnValid } from "../mask/generators.js";

const EMAIL_RE =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

// International (+…) and Swiss 0xx / +41
const PHONE_RE =
  /(?<![0-9])(?:\+|00)(?:[1-9]\d{0,3})[\s./-]?(?:\(?\d{1,4}\)?[\s./-]?){2,6}\d{2,4}(?!\d)|(?<![0-9])0\d{1,2}[\s./-]?(?:\d{2,3}[\s./-]?){2,4}\d{2}(?!\d)/g;

const IPV4_RE =
  /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/g;

const IPV6_RE =
  /(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?::[0-9A-Fa-f]{1,4}){1,7})(?![0-9A-Fa-f:])/g;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g;

const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;

const AHV_RE = /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g;

const DATE_RE =
  /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/g;

const DOB_CONTEXT =
  /(?:^|[^A-Za-zÀ-ÿ])(?:born|geboren|n[eé](?:e)?|dob|date of birth|geburtsdatum|naissance)(?![A-Za-zÀ-ÿ])/i;

function pushMatch(
  out: Detection[],
  type: EntityType,
  text: string,
  match: RegExpExecArray,
): void {
  const value = match[0];
  const start = match.index;
  out.push({ type, value, start, end: start + value.length, source: "regex" });
}

function isPersonalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.search && u.search.length > 1) return true;
    const path = u.pathname.toLowerCase();
    return /\/(user|users|profile|account|person|patient|customer|member|id|ssn|email)\b/i.test(
      path,
    );
  } catch {
    return url.includes("?");
  }
}

export function detectRegex(text: string): Detection[] {
  const out: Detection[] = [];

  for (const re of [EMAIL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) pushMatch(out, "email", text, m);
  }

  PHONE_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = PHONE_RE.exec(text))) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) continue;
      pushMatch(out, "phone", text, m);
    }
  }

  IPV4_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = IPV4_RE.exec(text))) pushMatch(out, "ipv4", text, m);
  }

  IPV6_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = IPV6_RE.exec(text))) pushMatch(out, "ipv6", text, m);
  }

  URL_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      if (!isPersonalUrl(m[0])) continue;
      pushMatch(out, "url", text, m);
    }
  }

  UUID_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = UUID_RE.exec(text))) pushMatch(out, "uuid", text, m);
  }

  CC_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = CC_RE.exec(text))) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) continue;
      if (!luhnValid(digits)) continue;
      pushMatch(out, "credit_card", text, m);
    }
  }

  IBAN_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = IBAN_RE.exec(text))) {
      if (!ibanValid(m[0])) continue;
      pushMatch(out, "iban", text, m);
    }
  }

  AHV_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = AHV_RE.exec(text))) {
      if (!ahvValid(m[0])) continue;
      pushMatch(out, "ahv", text, m);
    }
  }

  DATE_RE.lastIndex = 0;
  {
    let m: RegExpExecArray | null;
    while ((m = DATE_RE.exec(text))) {
      const windowStart = Math.max(0, m.index - 40);
      const window = text.slice(windowStart, m.index + m[0].length + 10);
      if (!DOB_CONTEXT.test(window)) continue;
      pushMatch(out, "date_of_birth", text, m);
    }
  }

  return mergeOverlaps(out);
}

/** Prefer longer spans; stable by start. */
export function mergeOverlaps(detections: Detection[]): Detection[] {
  const sorted = [...detections].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });
  const kept: Detection[] = [];
  for (const d of sorted) {
    const last = kept[kept.length - 1];
    if (!last || d.start >= last.end) {
      kept.push(d);
      continue;
    }
    // overlap: keep longer; on tie keep existing (caller can prefer regex by sorting)
    const lastLen = last.end - last.start;
    const dLen = d.end - d.start;
    if (dLen > lastLen) {
      kept[kept.length - 1] = d;
    }
  }
  return kept;
}
