/**
 * Smoke test against a real detector (Apertus or Ollama) plus a local mock upstream.
 *
 *   Set DETECTOR_API_KEY in .env, then: bun scripts/smoke.ts
 *   For Ollama, set DETECTOR_BASE_URL and DETECTOR_MODEL in .env.
 */
import { createServer } from "node:http";
import { createGateway } from "../src/server.js";
import { parseConfig } from "../src/config.js";

async function main(): Promise<void> {
  const config = parseConfig(["--detection", "llm+regex", ...process.argv.slice(2)]);
  if (!config.detectorApiKey && !config.detectorBaseUrl.includes("11434")) {
    console.error("Set DETECTOR_API_KEY in .env (or point DETECTOR_BASE_URL at local Ollama).");
    process.exit(1);
  }

  let sawReal = false;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("Marcus Weber") || body.includes("alice@example.com")) {
        sawReal = true;
        console.error("FAIL: upstream saw real PII");
      } else {
        console.log("OK: upstream body is masked");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: `Received ${body.length} bytes`,
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upAddr = upstream.address();
  if (!upAddr || typeof upAddr === "string") throw new Error("no port");
  config.upstream = `http://127.0.0.1:${upAddr.port}/v1`;

  const gw = createGateway(config);
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  const gwAddr = gw.server.address();
  if (!gwAddr || typeof gwAddr === "string") throw new Error("no gw port");
  const base = `http://127.0.0.1:${gwAddr.port}`;

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer smoke-key",
    },
    body: JSON.stringify({
      model: "smoke",
      messages: [
        {
          role: "user",
          content: "Patient Marcus Weber, email alice@example.com, please summarize.",
        },
      ],
    }),
  });

  const text = await res.text();
  console.log("gateway status", res.status);
  console.log("client body", text.slice(0, 300));
  if (res.status !== 200) {
    process.exitCode = 1;
  } else if (sawReal) {
    process.exitCode = 1;
  } else if (!text.includes("alice@example.com") && !text.includes("Marcus")) {
    // unmask may restore depending on detector finding names
    console.log("Note: name/email may not appear in echo if only length returned");
  }

  await gw.close();
  await new Promise<void>((r) => upstream.close(() => r()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
