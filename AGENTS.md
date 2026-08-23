# Kidbot Working Guide

## Repository structure

- `firmware/` is ESP-IDF 5.5.4 firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2.
- `worker/src/index.js` owns authenticated `/session` and `/progress`, the signed ElevenLabs webhook, and the `SessionCounter` Durable Object.
- `worker/src/progress.mjs` owns normalized progress rules; keep its behavior covered by Node built-in tests in `worker/test/`.
- `worker/scripts/configure_agent.sh` is the source of truth for agent audio, voice/model, turn behavior, client events, privacy, prompt, and guardrails.
- `docs/` is public user documentation. Keep commands generic and never add local absolute paths.

## Architecture and session flow

- Short tap -> authenticated `GET /session` -> signed ElevenLabs WebSocket -> timed PCM upload -> queued playback -> explicit `agent_response_complete` -> short tap closes with code `1000`.
- Post-call analysis -> signed transcription webhook -> normalized topic/date storage -> authenticated `/progress` -> NVS cache -> swipe-left curiosity map.
- Host tests use `/session?progress=0` and must never alter the map.

## Commands

```sh
. /path/to/esp-idf-v5.5.4/export.sh
idf.py -C firmware build
idf.py -C firmware -p /dev/your-serial-port app-flash
idf.py -C firmware -p /dev/your-serial-port monitor

cd worker
npm ci
npm test
npm run check
python3 -m py_compile scripts/*.py
bash -n scripts/*.sh
shellcheck scripts/*.sh
./scripts/configure_agent.sh
./scripts/configure_progress_webhook.sh
python3 scripts/convai_test.py /path/to/question.wav --no-play
python3 scripts/safety_tests.py
```

Cloud deployment and agent changes are maintainer-only manual actions. Never run them as part of tests or CI.

## Curiosity-map invariants

- The map is a rolling, Sunday-aligned 84-day view. It shows distinct safe topic IDs per Jerusalem-local day, visually capped at four; it never shows scores, streaks, missed days, or mastery claims.
- Only these IDs may cross the webhook boundary or enter storage: `space`, `jungle`, `detectives`, `oceans`, `dinosaurs`, `inventors`, `human_body`, `ancient_egypt`, `insects`, `weather`, `other`.
- Never persist webhook transcripts, audio, summaries, rationales, or arbitrary child text. Store only normalized IDs, local dates, aggregate counts, revision, latest topic, and short-lived conversation-ID deduplication data.
- Keep progress HTTP/NVS work outside LVGL and the audio pipeline. Failed or malformed refreshes leave the last valid cache intact.

## Audio invariants

- PCM is always 16 kHz, signed 16-bit, mono in both directions.
- Keep half duplex: upload microphone PCM only while listening; upload equal-duration zero PCM while buffering, playing, and flushing microphone input.
- Playback ends only after `agent_response_complete` and an empty playback queue. Packet gaps are not response boundaries.
- Keep `PREBUFFER` in `firmware/main/pipeline.c` as a hardware calibration knob. The current `48,000` bytes is the measured 1.5-second setting.
- Keep automatic WebSocket reconnect disabled because a signed raw conversation cannot be resumed safely.

## Safety and privacy rules

- Default agent configuration is `private blocking`; diagnostics records voice for seven days and must be an explicit temporary choice.
- Zero-day scheduled deletion is not ElevenLabs Enterprise Zero Retention Mode. Make no legal-compliance claim.
- Child name, age, grammatical form, voice ID, API keys, agent ID, device token, Worker URL, and webhook secret are private configuration.
- Keep visible listening/buffering/playback states and tap-to-listen behavior.
- Do not add child transcripts, recordings, identifying examples, or live service identifiers to tests, fixtures, logs, documentation, or commits.

## Generated files and secrets

- Keep Worker secrets only in `worker/.dev.vars` or Cloudflare secrets. Never print or commit them.
- Copy `firmware/main/wifi_creds.h.example` to ignored `firmware/main/wifi_creds.h`. Never commit the real file.
- Commit `firmware/dependencies.lock` for reproducible board builds, but regenerate it through ESP-IDF rather than editing it by hand.
- Do not edit or commit `firmware/build/`, `firmware/managed_components/`, generated `firmware/sdkconfig*`, `worker/.wrangler/`, `node_modules/`, caches, or audio fixtures.

## Required verification

- Run the smallest relevant tests, then all Worker checks for Worker changes and a clean ESP-IDF build for firmware changes.
- After a firmware build, require `git diff --exit-code -- firmware/dependencies.lock`.
- For user-visible firmware changes, verify the real V2 device: tap, states, authenticated session, 16 kHz PCM, complete playback, `agent_response_complete`, and close code `1000`.
- Run the host conversation test only with a maintainer-supplied WAV and `progress=0`; run all four safety cases after agent changes.
- Before publication, scan staged files for secrets, personal identifiers, live URLs, absolute paths, audio, generated folders, and caches.
