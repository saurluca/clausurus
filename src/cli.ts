#!/usr/bin/env node
import { helpText, parseConfig } from "./config.js";
import { createGateway, listen } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    process.exit(0);
  }

  let config;
  try {
    config = parseConfig(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (!config.upstream && !config.inspect) {
    console.error("Pass --upstream <url> or set UPSTREAM_BASE_URL (or use --inspect).");
    process.exit(1);
  }

  if (config.detection === "llm+regex" && !config.detectorApiKey && !config.inspect) {
    console.warn(
      "Warning: DETECTOR_API_KEY is unset. Detector calls may fail; use --detection regex or set the key.",
    );
  }

  const gateway = createGateway(config);
  await listen(gateway, config);

  const base = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  console.log(`Apertus privacy gateway listening on ${base}`);
  if (config.upstream) {
    console.log(`Upstream: ${config.upstream}`);
  }
  if (config.inspect) {
    console.log("Inspect mode: printing masked bodies the upstream would receive.");
  }
  console.log(`Detection: ${config.detection}`);
  console.log("");
  console.log("Point your app at this gateway, keep your own upstream API key:");
  console.log(`  OPENAI_BASE_URL=${base}/v1`);
  console.log(`  ANTHROPIC_BASE_URL=${base}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
