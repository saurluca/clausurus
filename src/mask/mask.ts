import type { Detection, DetectionSource, EntityType } from "../detect/types.js";
import type { SessionMap } from "./map.js";
import { collectMaskableStrings, walkStrings } from "./walk.js";

export type AppliedReplacement = {
  type: EntityType;
  real: string;
  fake: string;
  source: DetectionSource;
};

export function applyDetectionsToText(
  text: string,
  detections: Detection[],
  map: SessionMap,
  applied?: AppliedReplacement[],
): string {
  if (!detections.length) return text;
  const sorted = [...detections].sort((a, b) => b.start - a.start);
  let out = text;
  for (const d of sorted) {
    if (d.start < 0 || d.end > out.length || d.start >= d.end) continue;
    const slice = out.slice(d.start, d.end);
    if (slice !== d.value) continue;
    const fake = map.mask(d.type, d.value);
    if (applied && fake !== slice) {
      applied.push({ type: d.type, real: slice, fake, source: d.source });
    }
    out = out.slice(0, d.start) + fake + out.slice(d.end);
  }
  return out;
}

export function maskText(text: string, detections: Detection[], map: SessionMap): string {
  map.noteRequestValues([text, ...detections.map((d) => d.value)]);
  return applyDetectionsToText(text, detections, map);
}

export type MaskJsonResult = {
  value: unknown;
  map: SessionMap;
};

/**
 * Mask all string leaves using per-text detection lists (same order as collectMaskableStrings).
 */
export function maskJson(
  value: unknown,
  detectionsByText: Detection[][],
  map: SessionMap,
  applied?: AppliedReplacement[],
): unknown {
  const clone = structuredClone(value);
  const strings = collectMaskableStrings(clone);
  map.noteRequestValues(strings.flatMap((s, i) => [s, ...(detectionsByText[i] ?? []).map((d) => d.value)]));

  let i = 0;
  walkStrings(clone, (visit) => {
    const dets = detectionsByText[i] ?? [];
    i++;
    visit.set(applyDetectionsToText(visit.value, dets, map, applied));
  });
  map.clearRequestValues();
  return clone;
}

/** Spans applied to this body. Repeats of the same type and real value collapse. */
export function uniqueReplacements(list: AppliedReplacement[]): AppliedReplacement[] {
  const seen = new Set<string>();
  const out: AppliedReplacement[] = [];
  for (const r of list) {
    const key = `${r.type}\0${r.real}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
