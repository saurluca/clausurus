import type { EntityType } from "../detect/types.js";
import { generateFake } from "./generators.js";

function normalizeValue(type: EntityType, value: string): string {
  if (type === "email") return value.toLowerCase();
  return value;
}

function mapKey(type: EntityType, value: string): string {
  return `${type}\0${normalizeValue(type, value)}`;
}

export class SessionMap {
  readonly sessionId: string;
  private realToFake = new Map<string, string>();
  private fakeToReal = new Map<string, string>();
  private requestReals = new Set<string>();
  private typesSeen = new Map<EntityType, number>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Mark values present in the current request so fakes cannot collide with them. */
  noteRequestValues(values: Iterable<string>): void {
    for (const v of values) this.requestReals.add(v);
  }

  clearRequestValues(): void {
    this.requestReals.clear();
  }

  getFake(type: EntityType, real: string): string | undefined {
    return this.realToFake.get(mapKey(type, real));
  }

  getReal(fake: string): string | undefined {
    return this.fakeToReal.get(fake);
  }

  /** All fake -> real entries (for unmask regex). */
  entries(): IterableIterator<[string, string]> {
    return this.fakeToReal.entries();
  }

  fakes(): string[] {
    return [...this.fakeToReal.keys()];
  }

  maskedCount(): number {
    return this.realToFake.size;
  }

  maskedTypes(): EntityType[] {
    return [...this.typesSeen.keys()];
  }

  typeCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [t, n] of this.typesSeen) out[t] = n;
    return out;
  }

  mask(type: EntityType, real: string): string {
    const key = mapKey(type, real);
    const existing = this.realToFake.get(key);
    if (existing !== undefined) return existing;

    const maxAttempts = 64;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const fake = generateFake({ sessionId: this.sessionId, real, type, attempt });
      if (fake === real) continue;
      if (this.fakeToReal.has(fake)) continue;
      // reject if fake equals any already-mapped real (normalized compare for emails)
      let collidesReal = false;
      for (const [, mappedReal] of this.fakeToReal) {
        if (mappedReal === fake) {
          collidesReal = true;
          break;
        }
      }
      if (collidesReal) continue;
      if (this.requestReals.has(fake)) continue;
      // also reject if fake is already used as a real key value
      let usedAsReal = false;
      for (const k of this.realToFake.keys()) {
        const v = k.slice(k.indexOf("\0") + 1);
        if (v === normalizeValue(type, fake) || v === fake) {
          usedAsReal = true;
          break;
        }
      }
      if (usedAsReal) continue;

      this.realToFake.set(key, fake);
      this.fakeToReal.set(fake, real);
      this.typesSeen.set(type, (this.typesSeen.get(type) ?? 0) + 1);
      return fake;
    }
    throw new Error(`Unable to generate unique fake for type=${type}`);
  }
}
