import type { Detection } from "./types.js";

/** Merge regex + llm: regex wins on overlap, then longer span. */
export function mergeDetections(regex: Detection[], llm: Detection[]): Detection[] {
  const preferred = [
    ...regex.map((d) => ({ ...d, source: "regex" as const })),
    ...llm.map((d) => ({ ...d, source: "llm" as const })),
  ];
  // Sort: start asc, regex before llm on same start, longer first
  preferred.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.source !== b.source) return a.source === "regex" ? -1 : 1;
    return b.end - a.end - (a.end - a.start);
  });
  const kept: Detection[] = [];
  for (const d of preferred) {
    const overlapIdx = kept.findIndex((k) => d.start < k.end && d.end > k.start);
    if (overlapIdx < 0) {
      kept.push(d);
      continue;
    }
    const existing = kept[overlapIdx]!;
    // regex wins
    if (existing.source === "regex" && d.source === "llm") continue;
    if (existing.source === "llm" && d.source === "regex") {
      kept[overlapIdx] = d;
      continue;
    }
    const eLen = existing.end - existing.start;
    const dLen = d.end - d.start;
    if (dLen > eLen) kept[overlapIdx] = d;
  }
  return kept.sort((a, b) => a.start - b.start);
}
