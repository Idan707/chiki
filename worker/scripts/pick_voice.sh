#!/bin/bash
# List Hebrew community voices; with an arg, play that row's preview.
#   ./scripts/pick_voice.sh          -> table of candidates
#   ./scripts/pick_voice.sh 3        -> audition row 3
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=$(sed -n 's/^ELEVENLABS_API_KEY=//p' .dev.vars | head -1)
[ -n "$KEY" ] || { echo "ELEVENLABS_API_KEY missing from .dev.vars" >&2; exit 1; }
KIDBOT_VOICE_CACHE=/tmp/kidbot_voices.json
[ -s "$KIDBOT_VOICE_CACHE" ] || curl -sf \
  "https://api.elevenlabs.io/v1/shared-voices?language=he&page_size=100" \
  -H "xi-api-key: $KEY" > "$KIDBOT_VOICE_CACHE"

if [ -z "${1:-}" ]; then
  python3 - "$KIDBOT_VOICE_CACHE" <<'EOF'
import json, sys
vs = json.load(open(sys.argv[1]))["voices"]
vs.sort(key=lambda v: -(v.get("cloned_by_count") or 0))
for i, v in enumerate(vs[:25]):
    print(f'{i:2}  {v["name"][:28]:28} {v.get("gender","?"):8} {v.get("age","?"):12} '
          f'free={v.get("free_users_allowed")}  {v["voice_id"]}')
EOF
  printf '\naudition: %s <row>    then set ELEVEN_VOICE_ID in .dev.vars\n' "$0"
else
  URL=$(python3 - "$KIDBOT_VOICE_CACHE" "$1" <<'EOF'
import json, sys
vs = json.load(open(sys.argv[1]))["voices"]
vs.sort(key=lambda v: -(v.get("cloned_by_count") or 0))
v = vs[int(sys.argv[2])]
print(v["preview_url"]); import sys as s; print(f'{v["name"]}  {v["voice_id"]}', file=s.stderr)
EOF
  )
  curl -sf "$URL" -o /tmp/kidbot_preview.mp3 && afplay /tmp/kidbot_preview.mp3
fi
