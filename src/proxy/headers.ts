const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** Headers that must never be forwarded upstream. */
function isGatewayHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("x-pii-") || n.startsWith("x-upstream-");
}

export function copyRequestHeaders(
  incoming: Headers | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: Array<[string, string]> = [];
  if (typeof (incoming as Headers).forEach === "function") {
    (incoming as Headers).forEach((value, key) => entries.push([key, value]));
  } else {
    for (const [key, value] of Object.entries(incoming as Record<string, string | string[] | undefined>)) {
      if (value === undefined) continue;
      entries.push([key, Array.isArray(value) ? value.join(", ") : value]);
    }
  }
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (isGatewayHeader(lower)) continue;
    out[key] = value;
  }
  out["accept-encoding"] = "identity";
  return out;
}

export function copyResponseHeaders(
  upstream: Headers,
  audit?: { masked: number; types: string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  upstream.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "content-length") return;
    out[key] = value;
  });
  if (audit) {
    out["X-Pii-Masked"] = String(audit.masked);
    out["X-Pii-Types"] = audit.types.join(",");
  }
  return out;
}

export const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "anthropic-version",
]);
