/**
 * Score the detector on a seeded sample of ai4privacy/pii-masking-300k.
 *
 *   bun scripts/bench-pii.ts --limit 10 --seed 1
 *   bun scripts/bench-pii.ts --limit 50 --seed 7 --split train --detection regex
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sampleIndices } from "../bench/sample.js";
import { aggregate, scoreExample, type Span } from "../bench/score.js";
import { parseConfig } from "../src/config.js";
import { runDetection } from "../src/detect/pipeline.js";

const DATASET = "ai4privacy/pii-masking-300k";
const CACHE = join(import.meta.dirname, "..", "bench", "cache");

type GoldSpan = Span & { label: string };

type Row = {
  id: string;
  language: string;
  sourceText: string;
  gold: GoldSpan[];
};

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function intFlag(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${name} ${raw}`);
  return n;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hugging Face ${res.status} for ${url}`);
  return res.json();
}

async function shardPaths(split: string): Promise<string[]> {
  const body = (await getJson(
    `https://huggingface.co/api/datasets/${DATASET}/tree/main/data/${split}`,
  )) as Array<{ type?: string; path?: string }>;
  const paths = body
    .filter((f) => f.type === "file" && f.path?.endsWith(".jsonl"))
    .map((f) => f.path!)
    .sort();
  if (!paths.length) throw new Error(`No jsonl shards for split ${split}`);
  return paths;
}

async function ensureShard(remotePath: string): Promise<string> {
  const local = join(CACHE, remotePath);
  await mkdir(dirname(local), { recursive: true });
  const url = `https://huggingface.co/datasets/${DATASET}/resolve/main/${remotePath}`;
  const head = await fetch(url, { method: "HEAD" });
  const expected = Number(head.headers.get("content-length") ?? "0");
  try {
    const info = await stat(local);
    if (expected > 0 && info.size === expected) return local;
  } catch {
    // download
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Hugging Face ${res.status} for ${remotePath}`);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(local);
    const reader = res.body!.getReader();
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          out.end(() => resolve());
          return;
        }
        if (!out.write(value)) out.once("drain", pump);
        else pump();
      }, reject);
    };
    out.on("error", reject);
    pump();
  });
  return local;
}

/** Split on LF only. Readline also breaks on U+2028, which this dataset embeds inside JSON strings. */
async function linesOf(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

function asGold(raw: unknown): GoldSpan[] {
  const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  const gold: GoldSpan[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const span = item as { start?: unknown; end?: unknown; label?: unknown };
    if (typeof span.start !== "number" || typeof span.end !== "number") continue;
    gold.push({
      start: span.start,
      end: span.end,
      label: typeof span.label === "string" ? span.label : "?",
    });
  }
  return gold;
}

function parseRow(line: string, index: number): Row {
  const row = JSON.parse(line) as Record<string, unknown>;
  if (typeof row.source_text !== "string") {
    throw new Error(`Row ${index} has no source_text`);
  }
  return {
    id: typeof row.id === "string" ? row.id : String(index),
    language: typeof row.language === "string" ? row.language : "?",
    sourceText: row.source_text,
    gold: asGold(row.privacy_mask),
  };
}

/** Read the chosen line indexes from cached jsonl shards, in sample order. */
async function loadRows(files: string[], indexes: number[]): Promise<Row[]> {
  const want = new Map<number, number>();
  indexes.forEach((idx, i) => want.set(idx, i));
  const rows: Row[] = new Array(indexes.length);
  let global = 0;
  for (const file of files) {
    for (const line of await linesOf(file)) {
      const slot = want.get(global);
      if (slot !== undefined) rows[slot] = parseRow(line, global);
      global++;
    }
  }
  if (rows.some((r) => !r)) throw new Error("Sample index fell outside the downloaded split");
  return rows;
}

function pad(label: string, value: string): string {
  return `${label.padEnd(10)}${value}`;
}

async function detectWithRetry(config: ReturnType<typeof parseConfig>, text: string) {
  let waitMs = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await runDetection({ config, texts: [text] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("429") || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs *= 2;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = intFlag(argv, "--limit", 10);
  const seed = intFlag(argv, "--seed", 1);
  const split = flag(argv, "--split") ?? "validation";
  if (split !== "train" && split !== "validation") {
    throw new Error(`Unknown --split ${split}. Use train or validation.`);
  }

  const config = parseConfig(argv);
  if (
    config.detection === "llm+regex" &&
    !config.detectorApiKey &&
    !config.detectorBaseUrl.includes("11434")
  ) {
    console.error("Set DETECTOR_API_KEY (or point DETECTOR_BASE_URL at local Ollama).");
    process.exit(1);
  }

  const paths = await shardPaths(split);
  const files: string[] = [];
  for (const path of paths) files.push(await ensureShard(path));
  let count = 0;
  for (const file of files) count += (await linesOf(file)).length;
  const indexes = sampleIndices(count, limit, seed);
  const rows = await loadRows(files, indexes);

  console.log(pad("dataset", DATASET));
  console.log(pad("split", split));
  console.log(pad("seed", String(seed)));
  console.log(pad("limit", String(limit)));
  console.log(pad("detection", config.detection));
  console.log("");

  const scores = [];
  for (const row of rows) {
    const { byText } = await detectWithRetry(config, row.sourceText);
    const pred = (byText[0] ?? []).map((d) => ({ start: d.start, end: d.end }));
    const scored = scoreExample(row.gold, pred);
    scores.push(scored);
    const miss = scored.misses.length ? scored.misses.join(",") : "-";
    console.log(
      `id=${row.id} lang=${row.language} gold=${scored.gold} hit=${scored.goldHits} miss=${miss}`,
    );
  }

  const { f1, coverage } = aggregate(scores);
  console.log("");
  console.log(pad("F1", f1.toFixed(2)));
  console.log(pad("Coverage", coverage.toFixed(2)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
