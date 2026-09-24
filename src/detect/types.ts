export type EntityType =
  | "email"
  | "phone"
  | "ipv4"
  | "ipv6"
  | "url"
  | "uuid"
  | "credit_card"
  | "iban"
  | "ahv"
  | "date_of_birth"
  | "person_name"
  | "organization"
  | "location"
  | "address"
  | "medical_record"
  | "insurance_id"
  | "other_id";

export type DetectionSource = "regex" | "llm";

export type Detection = {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  source: DetectionSource;
};
