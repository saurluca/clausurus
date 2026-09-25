const KEY = "pii-logs";
const MAX = 80;

export type LogLine = { t: number; message: string };

/** ponytail: last-write-wins if two errors land in the same tick. Fine for a debug log. */
export function pushLog(message: string): void {
  const session = globalThis.chrome?.storage?.session;
  if (!session || !message) return;
  void session.get(KEY).then((stored) => {
    const logs: LogLine[] = Array.isArray(stored[KEY]) ? stored[KEY] : [];
    if (logs.at(-1)?.message === message) return;
    logs.push({ t: Date.now(), message });
    return session.set({ [KEY]: logs.slice(-MAX) });
  });
}

export function readLogs(): Promise<LogLine[]> {
  return chrome.storage.session.get(KEY).then((stored) => (Array.isArray(stored[KEY]) ? stored[KEY] : []));
}
