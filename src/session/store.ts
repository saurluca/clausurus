import { randomUUID } from "node:crypto";
import { SessionMap } from "../mask/map.js";

type Entry = {
  map: SessionMap;
  expiresAt: number;
};

export class SessionStore {
  private sessions = new Map<string, Entry>();
  constructor(private ttlSeconds: number) {}

  getOrCreate(sessionId: string | undefined): SessionMap {
    this.sweep();
    const id = sessionId?.trim() || randomUUID();
    const existing = this.sessions.get(id);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      existing.expiresAt = now + this.ttlSeconds * 1000;
      return existing.map;
    }
    const map = new SessionMap(id);
    this.sessions.set(id, { map, expiresAt: now + this.ttlSeconds * 1000 });
    return map;
  }

  /** Always fresh map (no X-Pii-Session). */
  fresh(): SessionMap {
    return new SessionMap(randomUUID());
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, e] of this.sessions) {
      if (e.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
