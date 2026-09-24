import { env, pipeline, type TokenClassificationPipeline } from "@huggingface/transformers";
import type { Detection, EntityType } from "../../../src/detect/types.js";

type ChosenModel = {
  id: string;
  dtype: "q8" | "fp32";
  labels: Record<string, EntityType | null>;
};

const LABEL_FALLBACK: Record<string, EntityType | null> = {
  PER: "person_name",
  PERSON: "person_name",
  ORG: "organization",
  LOC: "location",
  ADDRESS: "address",
  MISC: null,
};

let chosen: ChosenModel | null = null;
let ner: Promise<TokenClassificationPipeline> | null = null;
const cache = new Map<string, Detection[]>();

async function loadChosen(): Promise<ChosenModel> {
  if (chosen) return chosen;
  const url = chrome.runtime.getURL("models/chosen.json");
  const res = await fetch(url);
  if (!res.ok) throw new Error("models/chosen.json missing");
  chosen = (await res.json()) as ChosenModel;
  return chosen;
}

async function cacheKey(text: string, labels: EntityType[]): Promise<string> {
  const raw = `${labels.slice().sort().join(",")}\0${text}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function digestDelay(): Promise<void> {
  const stored = await chrome.storage.session.get("nerDelayMs");
  const ms = stored.nerDelayMs;
  if (typeof ms === "number" && ms > 0) await new Promise((r) => setTimeout(r, ms));
}

function loadPipeline(model: ChosenModel): Promise<TokenClassificationPipeline> {
  ner ??= (async () => {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = chrome.runtime.getURL("models/");
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/ort/");
    }
    const device = navigator.gpu ? "webgpu" : "wasm";
    return pipeline("token-classification", model.id, { dtype: model.dtype, device });
  })();
  return ner;
}

function groupToType(group: string, labels: Record<string, EntityType | null>): EntityType | null {
  const key = group.replace(/^[BI]-/, "").toUpperCase();
  if (key in labels) return labels[key] ?? null;
  return LABEL_FALLBACK[key] ?? null;
}

async function detect(text: string, labels: EntityType[]): Promise<Detection[]> {
  await digestDelay();
  const model = await loadChosen();
  const key = await cacheKey(text, labels);
  const hit = cache.get(key);
  if (hit) return hit.filter((d) => labels.includes(d.type));

  const classifier = await loadPipeline(model);
  const raw = await classifier(text, { aggregation_strategy: "simple" });
  const rows = Array.isArray(raw) ? raw : [];
  const wanted = new Set(labels);
  const detections: Detection[] = [];
  let cursor = 0;
  for (const row of rows) {
    const entity = String(row.entity_group ?? row.entity ?? "");
    const type = groupToType(entity, model.labels);
    const word = String(row.word ?? "").replace(/^##/, "");
    if (!type || !wanted.has(type) || !word) continue;
    const start = text.indexOf(word, cursor);
    if (start < 0) continue;
    const end = start + word.length;
    cursor = end;
    detections.push({ type, value: text.slice(start, end), start, end, source: "llm" });
  }
  cache.set(key, detections);
  return detections;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "warmup-model") {
    loadChosen()
      .then(loadPipeline)
      .then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
    return true;
  }
  if (msg?.type !== "ner-detect") return;
  const text = typeof msg.text === "string" ? msg.text : "";
  const labels = Array.isArray(msg.labels) ? (msg.labels as EntityType[]) : [];
  detect(text, labels).then(
    (detections) => sendResponse({ ok: true, detections }),
    (err) => sendResponse({ ok: false, error: String(err) }),
  );
  return true;
});
