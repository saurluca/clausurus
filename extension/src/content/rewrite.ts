/** The prompt is either raw or JSON-escaped inside Gemini's request body. */
export function bodyHasDraft(body: string, draft: string): boolean {
  if (!draft) return false;
  if (body.includes(draft)) return true;
  const escaped = JSON.stringify(draft).slice(1, -1);
  return escaped !== draft && body.includes(escaped);
}

export function spliceDraft(body: string, draft: string, masked: string): string {
  if (!draft || draft === masked) return body;
  if (body.includes(draft)) return body.split(draft).join(masked);
  const escaped = JSON.stringify(draft).slice(1, -1);
  const escapedMasked = JSON.stringify(masked).slice(1, -1);
  if (escaped !== draft && body.includes(escaped)) return body.split(escaped).join(escapedMasked);
  return body;
}
