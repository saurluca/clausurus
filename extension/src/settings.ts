import type { EntityType } from "../../src/detect/types.js";

export const ENTITY_TYPES: EntityType[] = [
  "email",
  "phone",
  "ipv4",
  "ipv6",
  "url",
  "uuid",
  "credit_card",
  "iban",
  "ahv",
  "date_of_birth",
  "person_name",
  "organization",
  "location",
  "address",
  "medical_record",
  "insurance_id",
  "other_id",
  "passport",
  "national_id",
  "driver_license",
  "id_card",
  "tracking_number",
];

/** Types the on-device model can emit. Structured types stay on regex. */
export const MODEL_TYPES: EntityType[] = ["person_name", "organization", "location", "address"];

export type TypeGroup = {
  id: string;
  label: string;
  types: EntityType[];
};

export const TYPE_GROUPS: TypeGroup[] = [
  { id: "contact", label: "Contact", types: ["email", "phone", "url"] },
  { id: "financial", label: "Financial", types: ["credit_card", "iban"] },
  { id: "government", label: "Government IDs", types: ["ahv", "passport", "national_id", "driver_license", "id_card"] },
  { id: "people", label: "People and places", types: ["person_name", "organization", "location", "address", "date_of_birth"] },
  { id: "technical", label: "Technical", types: ["ipv4", "ipv6", "uuid", "tracking_number"] },
  { id: "health", label: "Health", types: ["medical_record", "insurance_id"] },
  { id: "other", label: "Other", types: ["other_id"] },
];

const DEFAULT_OFF: EntityType[] = ["url", "uuid"];

export type OnDetectorError = "block" | "regex";

export type Settings = {
  enabled: boolean;
  types: Record<EntityType, boolean>;
  onDetectorError: OnDetectorError;
  /** Wait on send, including a cold load of the on-device model. */
  detectorTimeoutMs: number;
};

export const SETTINGS_KEY = "settings";

export function defaultSettings(): Settings {
  const types = Object.fromEntries(ENTITY_TYPES.map((t) => [t, !DEFAULT_OFF.includes(t)])) as Record<
    EntityType,
    boolean
  >;
  return { enabled: true, types, onDetectorError: "block", detectorTimeoutMs: 30_000 };
}

export function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const rec = raw as Partial<Settings>;
  if (typeof rec.enabled === "boolean") base.enabled = rec.enabled;
  if (rec.onDetectorError === "block" || rec.onDetectorError === "regex") {
    base.onDetectorError = rec.onDetectorError;
  }
  if (typeof rec.detectorTimeoutMs === "number" && rec.detectorTimeoutMs > 0 && rec.detectorTimeoutMs !== 1500) {
    base.detectorTimeoutMs = rec.detectorTimeoutMs;
  }
  if (rec.types && typeof rec.types === "object") {
    for (const t of ENTITY_TYPES) {
      const v = (rec.types as Record<string, unknown>)[t];
      if (typeof v === "boolean") base.types[t] = v;
    }
  }
  return base;
}

export function modelLabels(settings: Settings): EntityType[] {
  return MODEL_TYPES.filter((t) => settings.types[t]);
}
