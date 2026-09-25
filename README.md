# Apertus privacy gateway

One local process. Point your app at `localhost`, keep your own upstream API key, and personal data in JSON is swapped for fakes before it leaves your machine. The reply is swapped back.

The **detector** is any OpenAI-compatible chat model. [Apertus](https://www.swisscom.com/) (Swiss public model) is the default. You can use a local Ollama model instead. Only the detector sees real text; the upstream API only ever sees fakes.

## Quick start

```bash
DETECTOR_API_KEY=... npx apertus-privacy-gateway --upstream https://api.openai.com/v1
```

In your app, change only the base URL (key unchanged):

```bash
OPENAI_BASE_URL=http://localhost:8787/v1
```

For Anthropic: `--upstream https://api.anthropic.com` and `ANTHROPIC_BASE_URL=http://localhost:8787`.

Regex-only (no detector key):

```bash
npx apertus-privacy-gateway --detection regex --upstream https://api.openai.com/v1
```

Inspect what would be sent upstream (built-in mock):

```bash
npx apertus-privacy-gateway --inspect --detection regex
```

## Detector presets

| Preset | Env |
|--------|-----|
| **Apertus** (default) | `DETECTOR_BASE_URL` / `DETECTOR_MODEL` default to the Swisscom Apertus endpoint; set `DETECTOR_API_KEY` |
| **Ollama** | `DETECTOR_BASE_URL=http://localhost:11434/v1` `DETECTOR_MODEL=qwen3:1.7b` |
| **Custom** | Any OpenAI-compatible `/v1/chat/completions` host via `DETECTOR_BASE_URL` + `DETECTOR_MODEL` + `DETECTOR_API_KEY` |

Detection mode: `--detection llm+regex` (default) or `regex`. On detector failure, `ON_DETECTOR_ERROR=block` (default) returns `502` with `{"error":{"type":"pii_detection_failed"}}` and forwards nothing; set `regex` to fall back to regex-only.

## How it works

1. Your app sends the usual request (path, auth headers, JSON body) to the gateway.
2. Regex (+ optional LLM) finds personal spans; a session map replaces them with format-preserving fakes.
3. The gateway forwards the same path and auth headers to `--upstream` with the masked body.
4. The reply is unmasked (including SSE streams) so your app sees real values again.

Auth is transparent: `Authorization`, `x-api-key`, `api-key`, and `anthropic-version` are forwarded unchanged and never logged. The gateway only holds the detector key.

## Security model

- The real↔fake **map is personal data**. It lives **only in memory**, with a TTL (`SESSION_TTL_SECONDS`), and is dropped when the process exits. Map entries are never logged.
- **Only the detector** sees real text (Apertus, Ollama, or any endpoint you trust).
- Listen address defaults to `127.0.0.1`. `--host 0.0.0.0` is opt-in and prints a warning.
- Audit headers: `X-Pii-Masked` (count) and `X-Pii-Types` (types only)—never values.
- Non-JSON bodies: `415` unless `--allow-raw`. Malformed JSON: `400`, never forwarded raw.


## Gemini extension

Chrome extension that masks personal data in the Gemini composer, then shows the real values again in the chat. Gemini only receives the fakes. The real-to-fake map stays in `chrome.storage.session` and is dropped when the browser quits.

```bash
bun scripts/spike-ner.ts   # download and score the bundled NER model
bun run build:ext          # write extension/dist
```

Load `extension/` as an unpacked extension at `chrome://extensions`. The popup turns protection on or off and chooses which types to mask. `url` and `uuid` start off.

The on-device model is `Xenova/distilbert-base-multilingual-cased-ner-hrl` (quantized, 129 MB). A spike in `scripts/spike-ner.ts` scored it with `bench/score.ts` and `bench/sample.ts`: F1 1.0 on the short sample, about 9 ms per sentence under Node. `bert-base-NER` was smaller but slower and English-only. `gliner_small-v2.1` int8 is 175 MB, over the 150 MB budget, so it was not bundled. Names, organizations, and locations come from the model. Emails, phones, IBANs, and the other structured types stay on the regex detector. The model does not emit street addresses.

If the model errors or the Gemini composer cannot be found, the send is blocked and the toolbar badge shows `!`. The popup can switch that to regex-only. File uploads are not masked; the page shows a warning.

Manual check on gemini.google.com: new chat, a follow-up that keeps the same fakes, reload keeps the map, a browser restart leaves the fakes visible, the master switch disables masking, turning one type off leaves it unchanged, and both the English and German Send buttons still work.

```bash
bun test extension/tests
bunx playwright test --config extension/playwright.config.ts
```

## Develop

```bash
bun test
npx tsc --noEmit
bun src/cli.ts --detection regex --upstream https://api.openai.com/v1
```

Examples: `examples/curl.sh`, `examples/openai-sdk.ts`, `examples/anthropic-sdk.ts`. Smoke: `bun scripts/smoke.ts`.

## License

MIT
