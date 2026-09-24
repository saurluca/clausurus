import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Detection } from "./types.js";
import { detectRegex, mergeOverlaps } from "./regex.js";
import {
  DetectorError,
  detectLlmBatch,
  type LlmDetectorConfig,
} from "./llm.js";

export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private capacity: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next().value as string;
      this.map.delete(first);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

const cache = new LruCache<Detection[]>(256);

export function cacheKey(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

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

export type PipelineResult = {
  detections: Detection[];
  /** Per-text detection lists matching input order. */
  byText: Detection[][];
};

export type RunDetectOpts = {
  config: Config;
  texts: string[];
  fetchFn?: typeof fetch;
  /** Skip cache (tests). */
  bypassCache?: boolean;
};

export async function runDetection(opts: RunDetectOpts): Promise<PipelineResult> {
  const { config, texts, fetchFn, bypassCache } = opts;
  const byText: Detection[][] = texts.map(() => []);

  const regexResults = texts.map((t) => detectRegex(t));

  if (config.detection === "regex") {
    for (let i = 0; i < texts.length; i++) byText[i] = regexResults[i]!;
    return { detections: byText.flat(), byText };
  }

  const llmCfg: LlmDetectorConfig = {
    baseUrl: config.detectorBaseUrl,
    model: config.detectorModel,
    apiKey: config.detectorApiKey,
    fetchFn,
  };

  const llmResults: Detection[][] = [];
  try {
    // Cache per text
    const missingIdx: number[] = [];
    const missingTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const key = cacheKey(config.detectorModel, texts[i]!);
      const hit = bypassCache ? undefined : cache.get(key);
      if (hit) {
        llmResults[i] = hit;
      } else {
        missingIdx.push(i);
        missingTexts.push(texts[i]!);
        llmResults[i] = [];
      }
    }
    if (missingTexts.length) {
      const fresh = await detectLlmBatch(llmCfg, missingTexts);
      for (let j = 0; j < missingIdx.length; j++) {
        const i = missingIdx[j]!;
        llmResults[i] = fresh[j]!;
        if (!bypassCache) cache.set(cacheKey(config.detectorModel, texts[i]!), fresh[j]!);
      }
    }
  } catch (err) {
    if (config.onDetectorError === "regex") {
      for (let i = 0; i < texts.length; i++) byText[i] = regexResults[i]!;
      return { detections: byText.flat(), byText };
    }
    throw err instanceof DetectorError ? err : new DetectorError("Detector failed", err);
  }

  for (let i = 0; i < texts.length; i++) {
    byText[i] = mergeDetections(regexResults[i]!, llmResults[i]!);
  }
  return { detections: byText.flat(), byText };
}

export function clearDetectionCache(): void {
  cache.clear();
}

export { DetectorError };
