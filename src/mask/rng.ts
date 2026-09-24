/** Mulberry32 seeded PRNG — deterministic from a string seed. */

export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  digit(): string;
  letter(upper?: boolean): string;
};

export function createRng(seed: string | number): Rng {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(next() * arr.length)]!;
    },
    digit(): string {
      return String(Math.floor(next() * 10));
    },
    letter(upper = false): string {
      const c = String.fromCharCode(97 + Math.floor(next() * 26));
      return upper ? c.toUpperCase() : c;
    },
  };
}
