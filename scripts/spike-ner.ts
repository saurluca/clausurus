/**
 * Pick a bundled NER model.
 *   bun scripts/spike-ner.ts
 *
 * Measures file size, then scores token-classification models that fit in 150 MB
 * with bench/score.ts. Writes extension/models/chosen.json.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sampleIndices } from "../bench/sample.js";
import { aggregate, scoreExample, type Span } from "../bench/score.js";
import type { EntityType } from "../src/detect/types.js";

const BUDGET = 150 * 1024 * 1024;
const ROOT = join(import.meta.dirname, "..", "extension", "models");

type Candidate = {
  repo: string;
  file: string;
  labels: Record<string, EntityType | null>;
};

const CANDIDATES: Candidate[] = [
  {
    repo: "Xenova/distilbert-base-multilingual-cased-ner-hrl",
    file: "onnx/model_quantized.onnx",
    labels: { PER: "person_name", ORG: "organization", LOC: "location", MISC: null },
  },
  {
    repo: "Xenova/bert-base-NER",
    file: "onnx/model_quantized.onnx",
    labels: { PER: "person_name", ORG: "organization", LOC: "location", MISC: null },
  },
  {
    repo: "onnx-community/gliner_small-v2.1",
    file: "onnx/model_int8.onnx",
    labels: { PER: "person_name", ORG: "organization", LOC: "location", ADDRESS: "address" },
  },
];

const SAMPLE: Array<{ text: string; gold: Span[] }> = [
  { text: "Ada Lovelace emailed the lab.", gold: [{ start: 0, end: 12, label: "person_name" }] },
  { text: "Meet Marcus Weber in Zurich.", gold: [{ start: 5, end: 17, label: "person_name" }, { start: 21, end: 27, label: "location" }] },
  { text: "Anna Keller arbeitet bei Swisscom in Bern.", gold: [{ start: 0, end: 11, label: "person_name" }, { start: 25, end: 33, label: "organization" }, { start: 37, end: 41, label: "location" }] },
  { text: "Send this to the CERN office.", gold: [{ start: 16, end: 20, label: "organization" }] },
];

async function remoteSize(repo: string, file: string): Promise<number> {
  const url = `https://huggingface.co/${repo}/resolve/main/${file}`;
  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`${head.status} ${url}`);
  return Number(head.headers.get("content-length") ?? "0");
}

async function download(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    const info = await stat(dest);
    if (info.size > 0) return;
  } catch {
    // missing
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status} ${url}`);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(dest);
    const reader = res.body!.getReader();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          out.end(() => resolve());
          return;
        }
        out.write(value, (err) => (err ? reject(err) : pump()));
      }, reject);
    };
    pump();
  });
}

type Row = { entity_group?: string; entity?: string; word?: string; start?: number; end?: number };

async function scoreRepo(repo: string, labels: Record<string, EntityType | null>): Promise<{ f1: number; medianMs: number }> {
  const { env, pipeline } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = ROOT + "/";
  const classifier = await pipeline("token-classification", repo, { dtype: "q8" });
  const examples = [];
  const times: number[] = [];
  const picked = sampleIndices(SAMPLE.length, SAMPLE.length, 1).map((i) => SAMPLE[i]!);
  for (const sample of picked) {
    const start = performance.now();
    const raw = (await classifier(sample.text, { aggregation_strategy: "simple" })) as Row[];
    times.push(performance.now() - start);
    const pred: Span[] = [];
    let cursor = 0;
    for (const row of raw) {
      const key = String(row.entity_group ?? row.entity ?? "").replace(/^[BI]-/, "").toUpperCase();
      const type = labels[key];
      const word = row.word?.replace(/^##/, "");
      if (!type || !word) continue;
      const start = sample.text.indexOf(word, cursor);
      if (start < 0) continue;
      const end = start + word.length;
      cursor = end;
      pred.push({ start, end, label: type });
    }
    examples.push(scoreExample(sample.gold, pred));
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)] ?? 0;
  return { f1: aggregate(examples).f1, medianMs };
}

type Report = Candidate & { bytes: number; f1?: number; medianMs?: number; skipped?: string };

const reports: Report[] = [];
for (const candidate of CANDIDATES) {
  let bytes = 0;
  const localOnnx = join(ROOT, candidate.repo, candidate.file);
  try {
    bytes = (await stat(localOnnx)).size;
  } catch {
    try {
      bytes = await remoteSize(candidate.repo, candidate.file);
    } catch (err) {
      reports.push({ ...candidate, bytes: 0, skipped: err instanceof Error ? err.message : String(err) });
      console.log(`${candidate.repo} skipped: ${err}`);
      continue;
    }
  }
  const report: Report = { ...candidate, bytes };
  console.log(`${candidate.repo} ${candidate.file} ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (bytes > BUDGET) {
    report.skipped = "over 150 MB";
    reports.push(report);
    continue;
  }
  if (candidate.repo.includes("gliner")) {
    report.skipped = "not a token-classification graph";
    reports.push(report);
    continue;
  }
  const base = `https://huggingface.co/${candidate.repo}/resolve/main`;
  const dir = join(ROOT, candidate.repo);
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", candidate.file]) {
    await download(`${base}/${file}`, join(dir, file));
  }
  const scored = await scoreRepo(candidate.repo, candidate.labels);
  report.f1 = scored.f1;
  report.medianMs = scored.medianMs;
  console.log(`  f1 ${scored.f1.toFixed(3)} median ${scored.medianMs.toFixed(0)} ms`);
  reports.push(report);
}

const ranked = reports
  .filter((r) => r.f1 !== undefined && r.bytes <= BUDGET)
  .sort((a, b) => (b.f1! - a.f1!) || a.medianMs! - b.medianMs!);
const winner = ranked[0];
if (!winner) throw new Error("no candidate under 150 MB could be scored");

const chosen = {
  id: winner.repo,
  dtype: "q8",
  labels: winner.labels,
  bytes: winner.bytes,
  f1: winner.f1,
  medianMs: winner.medianMs,
  reports: reports.map(({ repo, file, bytes, f1, medianMs, skipped }) => ({ repo, file, bytes, f1, medianMs, skipped })),
};
await writeFile(join(ROOT, "chosen.json"), JSON.stringify(chosen, null, 2));
console.log(`chose ${winner.repo}`);
