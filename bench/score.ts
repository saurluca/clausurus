export type Span = { start: number; end: number; label?: string };

export type ExampleScore = {
  gold: number;
  pred: number;
  goldHits: number;
  predHits: number;
  coveredChars: number;
  goldChars: number;
  misses: string[];
};

export type AggregateScore = {
  f1: number;
  coverage: number;
};

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function coveredInSpan(gold: Span, preds: Span[]): number {
  const bits: Array<[number, number]> = [];
  for (const p of preds) {
    const start = Math.max(gold.start, p.start);
    const end = Math.min(gold.end, p.end);
    if (start < end) bits.push([start, end]);
  }
  bits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0;
  let end = -1;
  for (const [s, e] of bits) {
    if (s >= end) {
      covered += e - s;
      end = e;
    } else if (e > end) {
      covered += e - end;
      end = e;
    }
  }
  return covered;
}

export function scoreExample(gold: Span[], pred: Span[]): ExampleScore {
  const goldHits = gold.filter((g) => pred.some((p) => overlaps(g, p))).length;
  const predHits = pred.filter((p) => gold.some((g) => overlaps(g, p))).length;
  let coveredChars = 0;
  let goldChars = 0;
  const misses: string[] = [];
  for (const g of gold) {
    const len = Math.max(0, g.end - g.start);
    goldChars += len;
    const covered = coveredInSpan(g, pred);
    coveredChars += covered;
    if (covered === 0 && g.label) misses.push(g.label);
  }
  return { gold: gold.length, pred: pred.length, goldHits, predHits, coveredChars, goldChars, misses };
}

export function aggregate(examples: ExampleScore[]): AggregateScore {
  let gold = 0;
  let pred = 0;
  let goldHits = 0;
  let predHits = 0;
  let coveredChars = 0;
  let goldChars = 0;
  for (const e of examples) {
    gold += e.gold;
    pred += e.pred;
    goldHits += e.goldHits;
    predHits += e.predHits;
    coveredChars += e.coveredChars;
    goldChars += e.goldChars;
  }
  const precision = pred === 0 ? (gold === 0 ? 1 : 0) : predHits / pred;
  const recall = gold === 0 ? 1 : goldHits / gold;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const coverage = goldChars === 0 ? 1 : coveredChars / goldChars;
  return { f1, coverage };
}
