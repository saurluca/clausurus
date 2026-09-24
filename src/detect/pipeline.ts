import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Detection } from "./types.js";
import { detectRegex } from "./regex.js";
import { mergeDetections } from "./merge.js";
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

export { mergeDetections };

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
