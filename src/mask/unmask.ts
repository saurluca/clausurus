import type { SessionMap } from "./map.js";
import { walkStrings } from "./walk.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameVariants(fake: string, real: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [[fake, real]];
  if (/[a-zA-Z]/.test(fake)) {
    pairs.push([fake.toUpperCase(), real.toUpperCase()]);
    pairs.push([fake.toLowerCase(), real.toLowerCase()]);
  }
  return pairs;
}

/** Build replacement pairs: longest fake first. */
export function buildUnmaskPairs(map: SessionMap): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [fake, real] of map.entries()) {
    for (const [f, r] of nameVariants(fake, real)) {
      if (seen.has(f)) continue;
      seen.add(f);
      pairs.push([f, r]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

export function unmaskText(text: string, map: SessionMap): string {
  const pairs = buildUnmaskPairs(map);
  if (!pairs.length) return text;
  const re = new RegExp(pairs.map(([f]) => escapeRegExp(f)).join("|"), "g");
  const lookup = new Map(pairs);
  return text.replace(re, (m) => lookup.get(m) ?? m);
}

export function unmaskJson(value: unknown, map: SessionMap): unknown {
  const clone = structuredClone(value);
  walkStrings(clone, (visit) => {
    visit.set(unmaskText(visit.value, map));
  });
  return clone;
}

export function maxFakeLength(map: SessionMap): number {
  let max = 0;
  for (const fake of map.fakes()) {
    if (fake.length > max) max = fake.length;
    if (fake.toUpperCase().length > max) max = fake.toUpperCase().length;
  }
  return max;
}
