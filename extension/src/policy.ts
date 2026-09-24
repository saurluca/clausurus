import type { Detection, EntityType } from "../../src/detect/types.js";
import { mergeDetections } from "../../src/detect/merge.js";
import { applyDetectionsToText } from "../../src/mask/mask.js";
import type { SessionMap } from "../../src/mask/map.js";
import { modelLabels, type Settings } from "./settings.js";

export type MaskOk = { ok: true; masked: string; count: number };
export type MaskFail = { ok: false; error: "detector_failed" };
export type MaskOutcome = MaskOk | MaskFail;

export function filterByType(detections: Detection[], enabled: Record<EntityType, boolean>): Detection[] {
  return detections.filter((d) => enabled[d.type]);
}

/**
 * Combine regex and model spans, drop disabled types, and apply the session map.
 * A model failure blocks the send unless the user chose regex fallback.
 * When no model type is enabled, regex alone is enough.
 */
export function maskDraft(opts: {
  text: string;
  regex: Detection[];
  model: Detection[] | "failed";
  settings: Settings;
  map: SessionMap;
}): MaskOutcome {
  const { text, settings, map } = opts;
  if (!settings.enabled) return { ok: true, masked: text, count: 0 };

  const regex = filterByType(opts.regex, settings.types);
  const wantModel = modelLabels(settings).length > 0;
  let detections: Detection[];
  if (!wantModel) {
    detections = regex;
  } else if (opts.model === "failed") {
    if (settings.onDetectorError === "regex") detections = regex;
    else return { ok: false, error: "detector_failed" };
  } else {
    detections = filterByType(mergeDetections(regex, opts.model), settings.types);
  }

  const before = map.maskedCount();
  const masked = applyDetectionsToText(text, detections, map);
  return { ok: true, masked, count: map.maskedCount() - before };
}
