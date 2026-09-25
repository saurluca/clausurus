# Apertus privacy gateway

One local process. Point your app at `localhost`, keep your own upstream API key, and personal data in JSON is swapped for fakes before it leaves your machine. The reply is swapped back.

The **detector** is any OpenAI-compatible chat model. [Apertus](https://www.swisscom.com/) (Swiss public model) is the default. You can use a local Ollama model instead. Only the detector sees real text; the upstream API only ever sees fakes.

## Quick start

Copy `.env.example` to `.env` and set `DETECTOR_API_KEY` and `UPSTREAM_BASE_URL` there. Then:

```bash
npx apertus-privacy-gateway
```

In your app, change only the base URL (key unchanged):

```bash
OPENAI_BASE_URL=http://localhost:8787/v1
```

For Anthropic, set `UPSTREAM_BASE_URL=https://api.anthropic.com` in `.env` and `ANTHROPIC_BASE_URL=http://localhost:8787` in the app.

Regex-only (no detector key): set `DETECTION=regex` in `.env`.

Inspect what would be sent upstream (built-in mock): set `INSPECT=true` in `.env`.

## Detector presets

| Preset | Env |
|--------|-----|
| **Apertus** (default) | `DETECTOR_BASE_URL` / `DETECTOR_MODEL` default to the Swisscom Apertus endpoint; set `DETECTOR_API_KEY` |
| **Ollama** | `DETECTOR_BASE_URL=http://localhost:11434/v1` `DETECTOR_MODEL=qwen3:1.7b` |
| **Custom** | Any OpenAI-compatible `/v1/chat/completions` host via `DETECTOR_BASE_URL` + `DETECTOR_MODEL` + `DETECTOR_API_KEY` |

Detection mode: `DETECTION=llm+regex` (default) or `regex` in `.env`. On detector failure, `ON_DETECTOR_ERROR=block` (default) returns `502` with `{"error":{"type":"pii_detection_failed"}}` and forwards nothing; set `regex` to fall back to regex-only.

## How it works

1. Your app sends the usual request (path, auth headers, JSON body) to the gateway.
2. Regex (+ optional LLM) finds personal spans; a session map replaces them with format-preserving fakes.
3. The gateway forwards the same path and auth headers to `UPSTREAM_BASE_URL` with the masked body.
4. The reply is unmasked (including SSE streams) so your app sees real values again.

Auth is transparent: `Authorization`, `x-api-key`, `api-key`, and `anthropic-version` are forwarded unchanged and never logged. The gateway only holds the detector key.

## Security model

- The real↔fake **map is personal data**. It lives **only in memory**, with a TTL (`SESSION_TTL_SECONDS`), and is dropped when the process exits. Map entries are never logged.
- **Only the detector** sees real text (Apertus, Ollama, or any endpoint you trust).
- Listen address defaults to `127.0.0.1`. `HOST=0.0.0.0` in `.env` is opt-in and prints a warning.
- Audit headers: `X-Pii-Masked` (count) and `X-Pii-Types` (types only)—never values.
- Non-JSON bodies: `415` unless `--allow-raw`. Malformed JSON: `400`, never forwarded raw.

## Develop

```bash
bun test
npx tsc --noEmit
bun src/cli.ts
```

Examples: `examples/curl.sh`, `examples/openai-sdk.ts`, `examples/anthropic-sdk.ts`. Smoke: `bun scripts/smoke.ts`.

## License

MIT
