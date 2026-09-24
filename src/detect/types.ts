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
  | "other_id"
  | "passport"
  | "national_id"
  | "driver_license"
  | "id_card"
  | "tracking_number";

export type DetectionSource = "regex" | "llm";

export type Detection = {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  source: DetectionSource;
};
