#!/usr/bin/env bash
# Demo: start the gateway in another terminal, then run this script.
#   cp .env.example .env   # set UPSTREAM_BASE_URL and DETECTOR_API_KEY
#   bun src/cli.ts
set -euo pipefail
BASE="${GATEWAY_URL:-http://127.0.0.1:8787}"
KEY="${OPENAI_API_KEY:-sk-test}"

curl -sS "${BASE}/_gateway/health" | head -c 200
echo

curl -sS "${BASE}/v1/chat/completions" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${KEY}" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      {"role": "user", "content": "Email alice@example.com about IBAN CH93 0076 2011 6238 5295 7"}
    ]
  }' | head -c 800
echo
