import type { SessionMap } from "./map.js";
import { maxFakeLength, unmaskText } from "./unmask.js";

type Holdback = { buf: string };

function fakeList(map: SessionMap): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of map.fakes()) {
    for (const v of [f, f.toUpperCase(), f.toLowerCase()]) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/**
 * Emit the longest prefix that cannot be the start of any fake; hold the rest
 * (at most maxFakeLength - 1).
 */
export function splitHoldback(
  text: string,
  fakes: string[],
  maxHold: number,
): { emit: string; hold: string } {
  if (!text) return { emit: "", hold: "" };
  if (!fakes.length || maxHold <= 0) return { emit: text, hold: "" };
  let holdLen = 0;
  for (let i = Math.min(maxHold, text.length); i >= 1; i--) {
    const suffix = text.slice(text.length - i);
    if (fakes.some((f) => f.startsWith(suffix))) {
      holdLen = i;
      break;
    }
  }
  return {
    emit: text.slice(0, text.length - holdLen),
    hold: text.slice(text.length - holdLen),
  };
}

function processDelta(
  incoming: string,
  state: Holdback,
  map: SessionMap,
  fakes: string[],
  maxHold: number,
  flush: boolean,
): string {
  state.buf += incoming;
  if (flush) {
    const out = unmaskText(state.buf, map);
    state.buf = "";
    return out;
  }
  const { emit, hold } = splitHoldback(state.buf, fakes, maxHold);
  state.buf = hold;
  return unmaskText(emit, map);
}

function getPath(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[p as string];
  }
  return cur;
}

function setPath(obj: unknown, path: Array<string | number>, value: unknown): void {
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    cur = (cur as Record<string | number, unknown>)[path[i] as string];
  }
  (cur as Record<string | number, unknown>)[path[path.length - 1] as string] = value;
}

type DeltaSlot = { path: Array<string | number>; key: string };

function findDeltaSlots(event: Record<string, unknown>): DeltaSlot[] {
  const slots: DeltaSlot[] = [];

  const choices = event.choices;
  if (Array.isArray(choices)) {
    for (let i = 0; i < choices.length; i++) {
      const ch = choices[i] as Record<string, unknown> | undefined;
      const delta = ch?.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string") {
        slots.push({ path: ["choices", i, "delta", "content"], key: `oai-c-${i}` });
      }
      const tcs = delta.tool_calls;
      if (Array.isArray(tcs)) {
        for (let j = 0; j < tcs.length; j++) {
          const args = (tcs[j] as { function?: { arguments?: string } })?.function?.arguments;
          if (typeof args === "string") {
            slots.push({
              path: ["choices", i, "delta", "tool_calls", j, "function", "arguments"],
              key: `oai-a-${i}-${(tcs[j] as { index?: number }).index ?? j}`,
            });
          }
        }
      }
    }
  }

  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    slots.push({ path: ["delta"], key: "resp-delta" });
  }

  if (typeof event.index === "number" && event.delta && typeof event.delta === "object") {
    const d = event.delta as Record<string, unknown>;
    const idx = event.index;
    if (typeof d.text === "string") {
      slots.push({ path: ["delta", "text"], key: `ant-t-${idx}` });
    }
    if (typeof d.partial_json === "string") {
      slots.push({ path: ["delta", "partial_json"], key: `ant-j-${idx}` });
    }
  }

  return slots;
}

function shouldFlush(event: Record<string, unknown>, rawData: string): boolean {
  if (rawData.trim() === "[DONE]") return true;
  if (event.type === "message_stop" || event.type === "content_block_stop") return true;
  if (event.type === "response.completed") return true;
  const choices = event.choices;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      if ((ch as { finish_reason?: string | null }).finish_reason) return true;
    }
  }
  return false;
}

function pathKey(path: Array<string | number>): string {
  return "/" + path.join("/");
}

function unmaskOtherStrings(event: unknown, map: SessionMap, skipPaths: Set<string>): void {
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const p = `${path}/${i}`;
        if (typeof node[i] === "string") {
          if (!skipPaths.has(p)) node[i] = unmaskText(node[i] as string, map);
        } else walk(node[i], p);
      }
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const p = `${path}/${k}`;
        if (typeof obj[k] === "string") {
          if (!skipPaths.has(p)) obj[k] = unmaskText(obj[k] as string, map);
        } else walk(obj[k], p);
      }
    }
  };
  walk(event, "");
}

export function createSseUnmaskTransform(map: SessionMap): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const holdbacks = new Map<string, Holdback>();
  const fakes = fakeList(map);
  const maxHold = Math.max(0, maxFakeLength(map) - 1);

  const getHold = (key: string): Holdback => {
    let h = holdbacks.get(key);
    if (!h) {
      h = { buf: "" };
      holdbacks.set(key, h);
    }
    return h;
  };

  const flushAllHolds = (): void => {
    for (const h of holdbacks.values()) {
      h.buf = "";
    }
  };

  const processDataLine = (prefix: string, raw: string): string => {
    if (raw.trim() === "[DONE]") {
      flushAllHolds();
      return `${prefix}${raw}`;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return `${prefix}${unmaskText(raw, map)}`;
    }

    const slots = findDeltaSlots(event);
    const skip = new Set(slots.map((s) => pathKey(s.path)));
    const flush = shouldFlush(event, raw);

    for (const slot of slots) {
      const cur = getPath(event, slot.path);
      if (typeof cur !== "string") continue;
      const emitted = processDelta(cur, getHold(slot.key), map, fakes, maxHold, flush);
      setPath(event, slot.path, emitted);
    }

    if (flush) {
      // Flush remaining holdbacks into this event (finish often has empty delta)
      for (const [key, h] of holdbacks) {
        if (!h.buf) continue;
        const leftover = unmaskText(h.buf, map);
        h.buf = "";
        if (!leftover) continue;
        // Prefer matching slot path from key conventions
        if (key.startsWith("oai-c-")) {
          const i = Number(key.slice(6));
          const choices = event.choices as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(choices)) {
            const ch = choices[i] ?? (choices[i] = { index: i, delta: {} });
            const delta = (ch.delta as Record<string, unknown>) ?? (ch.delta = {});
            delta.content = String(delta.content ?? "") + leftover;
            skip.add(pathKey(["choices", i, "delta", "content"]));
          }
        } else if (key.startsWith("oai-a-")) {
          // oai-a-i-j
          const parts = key.split("-");
          const i = Number(parts[2]);
          const j = Number(parts[3]);
          const choices = event.choices as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(choices)) {
            const ch = choices[i] ?? (choices[i] = { index: i, delta: {} });
            const delta = (ch.delta as Record<string, unknown>) ?? (ch.delta = {});
            const tcs = (delta.tool_calls as unknown[]) ?? (delta.tool_calls = []);
            const tc = (tcs[j] as Record<string, unknown>) ?? (tcs[j] = { index: j, function: {} });
            const fn = (tc.function as Record<string, unknown>) ?? (tc.function = {});
            fn.arguments = String(fn.arguments ?? "") + leftover;
          }
        } else if (key.startsWith("ant-t-")) {
          const d = (event.delta as Record<string, unknown>) ?? (event.delta = {});
          d.text = String(d.text ?? "") + leftover;
          skip.add("/delta/text");
        } else if (key.startsWith("ant-j-")) {
          const d = (event.delta as Record<string, unknown>) ?? (event.delta = {});
          d.partial_json = String(d.partial_json ?? "") + leftover;
          skip.add("/delta/partial_json");
        } else if (key === "resp-delta") {
          event.delta = String(event.delta ?? "") + leftover;
          skip.add("/delta");
        }
      }
    }

    unmaskOtherStrings(event, map, skip);
    return `${prefix}${JSON.stringify(event)}`;
  };

  const processEventBlock = (block: string): string => {
    const lines = block.split("\n");
    return lines
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const prefix = line.startsWith("data: ") ? "data: " : "data:";
        const raw = line.slice(prefix.length);
        return processDataLine(prefix, raw);
      })
      .join("\n");
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        controller.enqueue(encoder.encode(processEventBlock(block) + "\n\n"));
      }
    },
    flush(controller) {
      // Flush holdbacks: if leftover pending event, force-flush deltas
      if (pending.trim()) {
        // Force flush by rewriting data lines with holdback flush
        const lines = pending.split("\n");
        const out = lines
          .map((line) => {
            if (!line.startsWith("data:")) return line;
            const prefix = line.startsWith("data: ") ? "data: " : "data:";
            const raw = line.slice(prefix.length);
            if (raw.trim() === "[DONE]") return processDataLine(prefix, raw);
            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              const slots = findDeltaSlots(event);
              for (const slot of slots) {
                const cur = getPath(event, slot.path);
                if (typeof cur !== "string") continue;
                const emitted = processDelta(cur, getHold(slot.key), map, fakes, maxHold, true);
                setPath(event, slot.path, emitted);
              }
              // Also flush any holdbacks for these keys that had empty delta
              for (const slot of slots) {
                const h = holdbacks.get(slot.key);
                if (h?.buf) {
                  const extra = unmaskText(h.buf, map);
                  h.buf = "";
                  const cur = getPath(event, slot.path);
                  setPath(event, slot.path, (typeof cur === "string" ? cur : "") + extra);
                }
              }
              unmaskOtherStrings(
                event,
                map,
                new Set(slots.map((s) => pathKey(s.path))),
              );
              return `${prefix}${JSON.stringify(event)}`;
            } catch {
              return processDataLine(prefix, raw);
            }
          })
          .join("\n");
        controller.enqueue(encoder.encode(out));
        pending = "";
      }
      // Remaining holdback with no event: append to nothing — emit into last empty is not possible.
      // Force-unmask and drop into a final content delta only if we still have buffer (tests flush with finish).
      for (const h of holdbacks.values()) {
        h.buf = "";
      }
    },
  });
}

/** Feed an SSE document (optionally in byte-size chunks) through the unmask transform. */
export async function unmaskSseString(
  sse: string,
  map: SessionMap,
  chunkSizes?: number[],
): Promise<string> {
  const transform = createSseUnmaskTransform(map);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const outPromise = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  })();

  if (chunkSizes?.length) {
    let offset = 0;
    for (const size of chunkSizes) {
      const piece = sse.slice(offset, offset + size);
      offset += size;
      if (piece) await writer.write(encoder.encode(piece));
    }
    if (offset < sse.length) await writer.write(encoder.encode(sse.slice(offset)));
  } else {
    await writer.write(encoder.encode(sse));
  }
  await writer.close();
  return outPromise;
}

/** Collect concatenated delta content from OpenAI-style SSE. */
export function collectOpenAiContent(sse: string): string {
  let content = "";
  for (const block of sse.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.replace(/^data:\s?/, "");
      if (raw.trim() === "[DONE]") continue;
      try {
        const ev = JSON.parse(raw) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const c = ev.choices?.[0]?.delta?.content;
        if (typeof c === "string") content += c;
      } catch {
        /* ignore */
      }
    }
  }
  return content;
}
