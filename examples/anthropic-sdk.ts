/**
 * Example: Anthropic Messages API through the privacy gateway.
 *
 *   Set UPSTREAM_BASE_URL=https://api.anthropic.com in .env
 *   bun src/cli.ts
 *   ANTHROPIC_API_KEY=... bun examples/anthropic-sdk.ts
 */
const baseURL = process.env.ANTHROPIC_BASE_URL ?? "http://localhost:8787";
const apiKey = process.env.ANTHROPIC_API_KEY ?? "sk-ant-test";

const res = await fetch(`${baseURL}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-3-5-sonnet-latest",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: "My AHV is 756.1234.5678.97 and email is anna@beispiel.ch",
      },
    ],
  }),
});

console.log(await res.text());

/*
  With the official SDK:

  import Anthropic from "@anthropic-ai/sdk";
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: "http://localhost:8787",
  });
*/
