import { describe, expect, test } from "bun:test";
import { SessionMap } from "../src/mask/map.js";
import {
  collectOpenAiContent,
  splitHoldback,
  unmaskSseString,
} from "../src/mask/stream.js";

function openAiSseFromContent(content: string, charChunks = true): string {
  const events: string[] = [];
  if (charChunks) {
    for (const ch of content) {
      events.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: ch }, index: 0 }] })}\n\n`,
      );
    }
  } else {
    events.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`,
    );
  }
  events.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n`,
  );
  events.push(`data: [DONE]\n\n`);
  return events.join("");
}

describe("splitHoldback", () => {
  test("holds prefix of fake", () => {
    const { emit, hold } = splitHoldback("hello al", ["alice@x.test"], 20);
    expect(hold).toBe("al");
    expect(emit).toBe("hello ");
  });
});

describe("SSE unmask split boundaries", () => {
  test("OpenAI content split at every character", async () => {
    const map = new SessionMap("stream-oai");
    const real = "alice@example.com";
    const fake = map.mask("email", real);
    const sse = openAiSseFromContent(`Contact ${fake} thanks`);
    // Feed one byte at a time
    const sizes = Array.from(sse, () => 1);
    const out = await unmaskSseString(sse, map, sizes);
    expect(collectOpenAiContent(out)).toBe(`Contact ${real} thanks`);
  });

  test("OpenAI tool arguments split", async () => {
    const map = new SessionMap("stream-args");
    const real = "bob@corp.com";
    const fake = map.mask("email", real);
    const args = JSON.stringify({ email: fake });
    let sse = "";
    for (const ch of args) {
      sse += `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ch } }],
            },
          },
        ],
      })}\n\n`;
    }
    sse += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`;
    sse += `data: [DONE]\n\n`;
    const out = await unmaskSseString(sse, map, Array.from(sse, () => 1));
    let rebuilt = "";
    for (const block of out.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.replace(/^data:\s?/, "");
        if (raw.trim() === "[DONE]") continue;
        try {
          const ev = JSON.parse(raw) as {
            choices?: Array<{
              delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> };
            }>;
          };
          const a = ev.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
          if (typeof a === "string") rebuilt += a;
        } catch {
          /* */
        }
      }
    }
    expect(rebuilt).toContain(real);
    expect(rebuilt).not.toContain(fake);
  });

  test("Anthropic text_delta split", async () => {
    const map = new SessionMap("stream-ant");
    const real = "carol@demo.org";
    const fake = map.mask("email", real);
    const text = `Hi ${fake}`;
    let sse = "";
    for (const ch of text) {
      sse += `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ch },
      })}\n\n`;
    }
    sse += `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`;
    sse += `data: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const out = await unmaskSseString(sse, map, Array.from(sse, () => 1));
    let rebuilt = "";
    for (const block of out.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.replace(/^data:\s?/, "");
        try {
          const ev = JSON.parse(raw) as { delta?: { text?: string } };
          if (typeof ev.delta?.text === "string") rebuilt += ev.delta.text;
        } catch {
          /* */
        }
      }
    }
    expect(rebuilt).toBe(`Hi ${real}`);
  });

  test("Anthropic input_json_delta split", async () => {
    const map = new SessionMap("stream-ant-j");
    const real = "dave@demo.org";
    const fake = map.mask("email", real);
    const partial = `{"email":"${fake}"}`;
    let sse = "";
    for (const ch of partial) {
      sse += `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ch },
      })}\n\n`;
    }
    sse += `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`;
    const out = await unmaskSseString(sse, map, Array.from(sse, () => 1));
    let rebuilt = "";
    for (const block of out.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.replace(/^data:\s?/, "");
        try {
          const ev = JSON.parse(raw) as { delta?: { partial_json?: string } };
          if (typeof ev.delta?.partial_json === "string") rebuilt += ev.delta.partial_json;
        } catch {
          /* */
        }
      }
    }
    expect(rebuilt).toContain(real);
  });

  test("empty delta still emitted", async () => {
    const map = new SessionMap("empty");
    map.mask("email", "a@b.co");
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "" }, index: 0 }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
      `data: [DONE]\n\n`;
    const out = await unmaskSseString(sse, map);
    expect(out).toContain('"content":""');
  });
});
