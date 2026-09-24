import type { Detection, EntityType } from "./types.js";

const LLM_TYPES = new Set<EntityType>([
  "person_name",
  "organization",
  "location",
  "address",
  "date_of_birth",
  "medical_record",
  "insurance_id",
  "other_id",
  "email",
  "phone",
  "ipv4",
  "ipv6",
]);

/** Benchmark labels from ai4privacy/pii-masking-300k, mapped onto maskable types. */
const BENCH_LABELS = new Map<string, EntityType>([
  ["GIVENNAME1", "person_name"],
  ["GIVENNAME2", "person_name"],
  ["LASTNAME1", "person_name"],
  ["LASTNAME2", "person_name"],
  ["LASTNAME3", "person_name"],
  ["USERNAME", "person_name"],
  ["TITLE", "person_name"],
  ["BOD", "date_of_birth"],
  ["DATE", "date_of_birth"],
  ["TIME", "other_id"],
  ["PASS", "other_id"],
  ["IDCARD", "other_id"],
  ["PASSPORT", "other_id"],
  ["DRIVERLICENSE", "other_id"],
  ["SOCIALNUMBER", "other_id"],
  ["CARDISSUER", "organization"],
  ["SEX", "other_id"],
  ["CITY", "location"],
  ["STATE", "location"],
  ["COUNTRY", "location"],
  ["GEOCOORD", "location"],
  ["STREET", "address"],
  ["BUILDING", "address"],
  ["POSTCODE", "address"],
  ["SECADDRESS", "address"],
  ["EMAIL", "email"],
  ["TEL", "phone"],
]);

const SYSTEM_PROMPT = `You are a PII detector for Swiss and international text (DE, FR, IT, EN, Swiss German).
Find every personal or sensitive span, including the categories listed below. Reply with JSON only, no markdown:
{"entities":[{"type":"person_name","value":"exact substring from the text"}]}
Allowed types: person_name, organization, location, address, date_of_birth, medical_record, insurance_id, other_id, email, phone, ipv4, ipv6.
Map categories onto those types:
- person_name: given names, surnames, usernames, titles
- date_of_birth: dates of birth and other dates
- other_id: passwords, id cards, passports, driver licenses, social-security numbers, sex, times
- organization: card issuers and other organizations
- location: city, state, country, coordinates
- address: street, building number, postcode, secondary address
- email: email addresses
- phone: telephone numbers
- ipv4 or ipv6: IP addresses
- medical_record and insurance_id when those appear
Copy each value exactly as it appears in the text. Do not invent values. If none, return {"entities":[]}.`;

export type LlmDetectorConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injected fetch for tests. */
  fetchFn?: typeof fetch;
};

export class DetectorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DetectorError";
  }
}

/** Endpoints that rejected response_format — remember per base URL. */
const noResponseFormat = new Set<string>();

const CHUNK_SIZE = 6000;

export function chunkText(text: string, maxLen = CHUNK_SIZE): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (breakAt > maxLen * 0.4) end = start + breakAt + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function stripToJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new DetectorError("No JSON object in detector reply");
  return raw.slice(start, end + 1);
}

function canonicalType(raw: string, value: string): EntityType | undefined {
  const key = raw.trim();
  if (LLM_TYPES.has(key as EntityType)) return key as EntityType;
  const upper = key.toUpperCase();
  if (upper === "IP") return value.includes(":") ? "ipv6" : "ipv4";
  return BENCH_LABELS.get(upper);
}

export function locateEntities(
  text: string,
  entities: Array<{ type: string; value: string }>,
): Detection[] {
  const out: Detection[] = [];
  const used: Array<{ start: number; end: number }> = [];
  for (const ent of entities) {
    if (!ent?.value || typeof ent.value !== "string") continue;
    const type = canonicalType(ent.type, ent.value);
    if (!type) continue;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(ent.value, from);
      if (idx < 0) break;
      const start = idx;
      const end = idx + ent.value.length;
      const overlaps = used.some((u) => start < u.end && end > u.start);
      if (!overlaps) {
        out.push({ type, value: ent.value, start, end, source: "llm" });
        used.push({ start, end });
        break;
      }
      from = idx + 1;
    }
  }
  return out;
}

async function callOnce(
  cfg: LlmDetectorConfig,
  userContent: string,
  useResponseFormat: boolean,
): Promise<{ status: number; body: string }> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload: Record<string, unknown> = {
    model: cfg.model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  if (useResponseFormat) {
    payload.response_format = { type: "json_object" };
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    throw new DetectorError("Detector request failed", err);
  } finally {
    clearTimeout(timer);
  }
}

function extractAssistantContent(httpBody: string): string {
  try {
    const parsed = JSON.parse(httpBody) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // fall through — treat raw body as the model reply
  }
  return httpBody;
}

function parseEntities(httpBody: string): Array<{ type: string; value: string }> {
  const content = extractAssistantContent(httpBody);
  const json = JSON.parse(stripToJsonObject(content)) as {
    entities?: Array<{ type: string; value: string }>;
  };
  return Array.isArray(json.entities) ? json.entities : [];
}

async function detectChunk(cfg: LlmDetectorConfig, chunk: string): Promise<Detection[]> {
  const endpointKey = cfg.baseUrl.replace(/\/$/, "");
  let useRf = !noResponseFormat.has(endpointKey);

  let result = await callOnce(cfg, chunk, useRf);
  if (result.status === 400 && useRf) {
    noResponseFormat.add(endpointKey);
    useRf = false;
    result = await callOnce(cfg, chunk, false);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new DetectorError(`Detector HTTP ${result.status}`);
  }

  try {
    return locateEntities(chunk, parseEntities(result.body));
  } catch (first) {
    // retry once on parse failure
    result = await callOnce(cfg, chunk, useRf);
    if (result.status < 200 || result.status >= 300) {
      throw new DetectorError(`Detector HTTP ${result.status}`, first);
    }
    try {
      return locateEntities(chunk, parseEntities(result.body));
    } catch (second) {
      throw new DetectorError("Detector JSON parse failed twice", second);
    }
  }
}

/** Reset remembered response_format support (tests). */
export function resetDetectorEndpointState(): void {
  noResponseFormat.clear();
}

export async function detectLlm(cfg: LlmDetectorConfig, text: string): Promise<Detection[]> {
  if (!text) return [];
  const chunks = chunkText(text);
  const perChunk = await Promise.all(chunks.map((c) => detectChunk(cfg, c)));
  const out: Detection[] = [];
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    for (const d of perChunk[i]!) {
      out.push({
        ...d,
        start: d.start + offset,
        end: d.end + offset,
      });
    }
    offset += chunk.length;
  }
  return out;
}

/** Batch multiple texts: one detection call per chunk group, returns detections per text. */
export async function detectLlmBatch(
  cfg: LlmDetectorConfig,
  texts: string[],
): Promise<Detection[][]> {
  // Separate calls per text (each may chunk internally). Parallel across texts.
  return Promise.all(texts.map((t) => detectLlm(cfg, t)));
}
