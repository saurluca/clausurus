/** mulberry32. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Partial Fisher-Yates. Same seed and population always yield the same indexes.
 * Indexes are unique and lie in [0, count).
 */
export function sampleIndices(count: number, limit: number, seed: number): number[] {
  if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid row count ${count}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid --limit ${limit}`);
  if (limit > count) throw new Error(`--limit ${limit} is larger than the split (${count} rows)`);
  const rng = mulberry32(seed);
  const at = new Map<number, number>();
  const get = (i: number): number => (at.has(i) ? at.get(i)! : i);
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(rng() * (count - i));
    const vi = get(i);
    const vj = get(j);
    at.set(i, vj);
    at.set(j, vi);
    out.push(vj);
  }
  return out;
}
