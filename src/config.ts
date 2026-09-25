import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type DetectionMode = "llm+regex" | "regex";
export type DetectorErrorMode = "block" | "regex";

export type Config = {
  upstream: string;
  allowUpstreamOverride: boolean;
  upstreamAllowlist: string[];
  detectorBaseUrl: string;
  detectorModel: string;
  detectorApiKey?: string;
  detection: DetectionMode;
  onDetectorError: DetectorErrorMode;
  port: number;
  host: string;
  sessionTtlSeconds: number;
  allowRaw: boolean;
  inspect: boolean;
};

export const APERTUS_BASE_URL =
  "https://api.swisscom.com/products/swiss-ai-weeks/apertus-1.5-70b/v1";
export const APERTUS_MODEL = "swiss-ai/Apertus-v1.5-70B";

function loadDotEnv(cwd: string): void {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function parseConfig(argv: string[], cwd = process.cwd()): Config {
  loadDotEnv(cwd);
  const env = process.env;
  const detection = (flag(argv, "--detection") ?? env.DETECTION ?? "llm+regex") as DetectionMode;
  if (detection !== "llm+regex" && detection !== "regex") {
    throw new Error(`Unknown --detection ${detection}. Use llm+regex or regex.`);
  }
  const onDetectorError = (env.ON_DETECTOR_ERROR ?? "block") as DetectorErrorMode;
  if (onDetectorError !== "block" && onDetectorError !== "regex") {
    throw new Error(`Unknown ON_DETECTOR_ERROR ${onDetectorError}. Use block or regex.`);
  }
  const upstream = flag(argv, "--upstream") ?? env.UPSTREAM_BASE_URL ?? "";
  return {
    upstream: upstream.replace(/\/$/, ""),
    allowUpstreamOverride:
      has(argv, "--allow-upstream-override") || env.ALLOW_UPSTREAM_OVERRIDE === "true",
    upstreamAllowlist: (env.UPSTREAM_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
    detectorBaseUrl: (env.DETECTOR_BASE_URL ?? APERTUS_BASE_URL).replace(/\/$/, ""),
    detectorModel: env.DETECTOR_MODEL ?? APERTUS_MODEL,
    detectorApiKey: env.DETECTOR_API_KEY || undefined,
    detection,
    onDetectorError,
    port: Number(flag(argv, "--port") ?? env.PORT ?? 8787),
    host: flag(argv, "--host") ?? env.HOST ?? "127.0.0.1",
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 3600),
    allowRaw: has(argv, "--allow-raw") || env.ALLOW_RAW_BODIES === "true",
    inspect: has(argv, "--inspect"),
  };
}

export function helpText(): string {
  return `apertus-privacy-gateway

  DETECTOR_API_KEY=... apertus-privacy-gateway --upstream https://api.openai.com/v1

  --upstream <url>              default model API
  --port <n>                    listen port (8787)
  --host <addr>                 listen address (127.0.0.1)
  --detection llm+regex|regex   detector layers
  --allow-upstream-override     honor X-Upstream-Base-URL when allowlisted
  --allow-raw                   forward non-JSON bodies unmasked
  --inspect                     print what the upstream receives

  POST /_gateway/preview        mask a JSON body and return replacements; does not forward
`;
}
