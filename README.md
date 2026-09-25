# Clausurus: Privacy Gateway

**A privacy checkpoint for AI chat. Use ChatGPT or Claude without handing them your personal data (PII).**

> Built at **Swiss {ai} Weeks 2026**.
> Status: hackathon prototype. Not production-ready and not a legal compliance guarantee.

When you paste a letter into an AI chatbot, everything in it (names, addresses, account numbers) goes to the company running the model. This gateway sits in between. Before your request goes out, it finds the personal details and masks them: each one is replaced with a realistic stand-in, not blacked out. The AI works on the masked version. When the answer comes back, the gateway unmasks it and restores the real details, so the reply reads as if nothing had changed.

## The problem

Public administrations, schools and regulated companies in Switzerland want the quality of
frontier models, but their daily work is full of personal data: names, addresses, AHV
numbers, IBANs, case details.

The rules are often strict. For example, the Canton of Zurich's guidance for its
administration says online AI generators are not an official work tool and that prompts
must not contain official personal data
([DSB Kanton Zürich](https://www.datenschutz.ch/tb/2023/online-ki-generatoren-bearbeiten-personendaten)).
In practice, people either give up on frontier AI or paste personal data into it anyway.

```
You write:      "... mein Name ist Martina Brunner-Keller, Lindenstrasse 14, 8739 Seewilen ..."
OpenAI sees:    "... mein Name ist Sabine Meier, Birkenweg 3, 8400 Winterthur ..."
You get back:   a reply addressed to Martina Brunner-Keller
```

*(Illustrative example, fictional data.)*

The only model that ever sees your real text is the **detector**, which finds the personal data. By default that's **Apertus**, Switzerland's fully open public model. You can also run a model on your own computer instead. Either way, the provider you're protecting your data from never does the detecting.

## Example

Here I asked the AI to write a conscie email based on my personal information for a Migros complaint. In red you can see the flagged personal info, and on the right you an see how it was replaced for the AI. In the final response you can see the real information you provided again, as it was placed back in.

![Clausurus chat: personal details are masked before they reach the model, then restored in the reply](clausurus.png)

## Features

- Use whichever model you want, how you want, while keeping your data safe.
- Personal information is only revealed to sources you trust.
- You keep your own API key; only the base URL changes.
- Works with OpenAI- and Anthropic-style APIs, including streamed replies.
- Personal details are swapped for realistic stand-ins, then restored in the reply.

## Why this needs *public* AI for detection

Regex catches numbers and known patterns; only a language model catches context (a name,
an address, or an indirect identifier like "the only vet in the village, elected in
2024"). That model has to be trustworthy, and you can't ask the vendor you're protecting
yourself from to also be the gatekeeper deciding what to hide from itself.

Apertus is fully open — weights, training data and training recipes are public. The
detection pass and this gateway's code are both inspectable by anyone, including a data
protection officer. You can also point the detector at a model running on your own
machine (e.g. Ollama) instead.

## Detected data types

| Type | Detection |
|---|---|
| Person name | Regex cue (`named`, `heisst`, …) + LLM detector |
| Email address | Regex |
| Phone number | Regex |
| Swiss AHV/AVS number | Regex (with checksum) |
| Credit card | Regex (Luhn check) |
| Bank account (IBAN) | Regex (mod-97 check) |
| IP address (v4/v6) | Regex |
| Date of birth | Regex, context-gated (`born`, `geboren`, `dob`, …) |
| Passport / national ID / driver's license / ID card | Regex, context-gated |
| Tracking / shipment number | Regex |
| Personal URL (profile, account, patient, …) | Regex |
| Organization, location, address | LLM detector |
| Medical record, insurance ID, other ID | LLM detector |

## Future plan

The same mask-and-restore path for anyone who wants an overseas-hosted model on data that should stay within national borders:

- Browser extension to make agentic privacy available to a broader market.
- Support of full agentic workflows with masked personal identifying information.
- System to cover multimodal input, incl. documents and audio transcription.
- Formal evaluation of detection recall/precision against a labelled Swiss dataset.
- Multi-model side-by-side comparison on the same masked prompt.

## In one paragraph, for developers

A single local process that proxies OpenAI- and Anthropic-style APIs. Point your app's base URL at `localhost` and keep your own upstream API key. Personal spans in the JSON body are detected (regex + an LLM detector) and masked with format-preserving substitutes from an in-memory session map. The masked request goes upstream with your auth headers unchanged, and the response, including SSE streams, is unmasked on the way back. If detection fails, nothing is forwarded (fail closed by default).

## Quick start

Copy `.env.example` to `.env` and insert your API keys (and any other values you want to change). Then:

```bash
npx clausurs
```

In your app, change only the base URL (key unchanged):

```bash
OPENAI_BASE_URL=http://localhost:8787/v1
```



## Detector presets


| Preset                | Env                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Apertus** (default) | `DETECTOR_BASE_URL` / `DETECTOR_MODEL` default to the Swisscom Apertus endpoint; set `DETECTOR_API_KEY`           |
| **Ollama**            | `DETECTOR_BASE_URL=http://localhost:11434/v1` `DETECTOR_MODEL=qwen3:1.7b`                                         |
| **Custom**            | Any OpenAI-compatible `/v1/chat/completions` host via `DETECTOR_BASE_URL` + `DETECTOR_MODEL` + `DETECTOR_API_KEY` |


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

## Threat model and limits

**What Clausurus protects against:** the model provider seeing *direct identifiers*
(names, AHV numbers, IBANs, addresses, phone numbers, emails) and, via the LLM detector,
many *contextual* ones.

**What it does not guarantee:**

- **Anonymity.** A rare combination of details can still identify someone.
- **Legal compliance.** Pseudonymised data can still count as personal data under Swiss
  data protection law and the GDPR. Clausurus supports data minimisation; it does not
  replace a data protection assessment by your organisation.
- **Content confidentiality.** The *content* of a message (e.g. a medical situation) is
  still sent — only the identifiers are replaced.
- **Multimodal input.** Currently text (JSON request/response bodies) only.
- **Detection errors.** Regex and the LLM detector both miss things. This is a hackathon
  prototype with no formal evaluation yet — see [Future plan](#future-plan).

## Develop

```bash
bun test
npx tsc --noEmit
bun src/cli.ts
```

Examples: `examples/curl.sh`, `examples/openai-sdk.ts`, `examples/anthropic-sdk.ts`. Smoke: `bun scripts/smoke.ts`.

## Contributing

Issues and pull requests are welcome. Please never commit real personal data or API
keys — `.env` is gitignored; keep it that way.

## License

MIT

## Acknowledgements

The [Swiss AI Initiative](https://www.swiss-ai.org) (Apertus) and Swiss {ai} Weeks.

---

*All names, AHV numbers, IBANs and addresses used in this repository are fictional or
widely published sample values.*