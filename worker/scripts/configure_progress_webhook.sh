#!/bin/bash
# One-time/re-runnable provisioning for Kidbot's signed post-call webhook.
set -euo pipefail
cd "$(dirname "$0")/.."

dev_var() { sed -n "s/^${1}=//p" .dev.vars | head -1; }
KEY=$(dev_var ELEVENLABS_API_KEY)
WORKER_URL=$(dev_var WORKER_URL)
[ -n "$KEY" ] || { echo "ELEVENLABS_API_KEY missing from .dev.vars" >&2; exit 1; }
[[ "$WORKER_URL" == https://* ]] ||
  { echo "WORKER_URL must be an https:// origin in .dev.vars" >&2; exit 1; }
NAME="Kidbot progress"
URL="${WORKER_URL%/}/webhooks/elevenlabs"
BASE="https://api.elevenlabs.io/v1/workspace/webhooks"

LIST=$(curl -fsSL -H "xi-api-key: $KEY" "$BASE?include_usages=true")
ID=$(printf '%s' "$LIST" | jq -r --arg url "$URL" '.webhooks[] | select(.webhook_url == $url) | .webhook_id' | head -1)
if [ -z "$ID" ]; then
  RESP=$(curl -sS -w '\n%{http_code}' -X POST "$BASE" -H "xi-api-key: $KEY" \
    -H 'Content-Type: application/json' --data "$(jq -n --arg name "$NAME" --arg url "$URL" \
      '{settings:{auth_type:"hmac",name:$name,webhook_url:$url}}')")
  CODE=$(printf '%s\n' "$RESP" | tail -1)
  CREATED=$(printf '%s\n' "$RESP" | sed '$d')
  [ "$CODE" = 200 ] || {
    echo "webhook creation failed ($CODE): $(printf '%s' "$CREATED" | jq -r '.detail.message // .detail // .')" >&2
    exit 1
  }
  ID=$(printf '%s' "$CREATED" | jq -er '.webhook_id')
  SECRET=$(printf '%s' "$CREATED" | jq -er '.webhook_secret')
  printf '%s' "$SECRET" | npx --no-install wrangler secret put ELEVEN_WEBHOOK_SECRET >/dev/null

  TMP=$(mktemp .dev.vars.XXXXXX)
  trap 'if [ -n "${TMP:-}" ]; then rm -f "$TMP"; fi' EXIT
  FOUND=false
  while IFS= read -r LINE || [ -n "$LINE" ]; do
    if [[ "$LINE" == ELEVEN_WEBHOOK_SECRET=* ]]; then
      printf 'ELEVEN_WEBHOOK_SECRET=%s\n' "$SECRET" >> "$TMP"
      FOUND=true
    else
      printf '%s\n' "$LINE" >> "$TMP"
    fi
  done < .dev.vars
  $FOUND || printf 'ELEVEN_WEBHOOK_SECRET=%s\n' "$SECRET" >> "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" .dev.vars
  TMP=
  unset SECRET
  echo "created webhook and stored its HMAC secret in Cloudflare and .dev.vars"
fi

curl -fsSL -X PATCH "$BASE/$ID" -H "xi-api-key: $KEY" -H 'Content-Type: application/json' \
  --data "$(jq -n --arg name "$NAME" \
    '{is_disabled:false,name:$name,retry_enabled:true,events:["post_call_transcription"]}')" >/dev/null

LIVE=$(curl -fsSL -H "xi-api-key: $KEY" "$BASE?include_usages=true")
printf '%s' "$LIVE" | jq -e --arg id "$ID" \
  '.webhooks[] | select(.webhook_id == $id) | .is_disabled == false and .is_auto_disabled == false' >/dev/null || {
    echo "webhook read-back failed" >&2; exit 1;
  }
echo "progress webhook ready: $ID"
