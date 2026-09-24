/**
 * Example: OpenAI SDK through the privacy gateway.
 *
 *   bun src/cli.ts --detection regex --upstream https://api.openai.com/v1
 *   OPENAI_API_KEY=sk-... bun examples/openai-sdk.ts
 *
 * Requires the `openai` package if you want to run this file as-is.
 * Shown here as the integration pattern; install openai separately.
 */
const baseURL = process.env.OPENAI_BASE_URL ?? "http://localhost:8787/v1";
const apiKey = process.env.OPENAI_API_KEY ?? "sk-test";

const res = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: "Contact Marcus Weber at marcus.weber@example.com",
      },
    ],
  }),
});

console.log(await res.text());

/*
  With the official SDK:

  import OpenAI from "openai";
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "http://localhost:8787/v1",
  });
  const completion = await client.chat.completions.create({ ... });
*/
