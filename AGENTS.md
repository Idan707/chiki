# Chiki Working Guide

## Repository structure

- `firmware/` is ESP-IDF 5.5.4 firmware for the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2.
- `worker/src/index.js` owns authenticated `/session`, `/progress`, `/talk`, the signed ElevenLabs webhook, and the `SessionCounter` Durable Object.
- `worker/src/talk.mjs` owns the prompt, the safety screen, and the Hebrew-only filter; `worker/src/gcp.mjs` owns service-account auth and Chirp3-HD synthesis; `worker/src/audio.mjs` owns turn detection and resampling. Both are pure and covered by Node built-in tests.
- `worker/src/progress.mjs` owns normalized progress rules; keep its behavior covered by Node built-in tests in `worker/test/`.
- `worker/scripts/configure_agent.sh` is the source of truth for the legacy ElevenLabs agent, kept live until the new firmware is verified on hardware.
- Every reply is screened as text before it is synthesized. Never add a path that speaks model output without passing it through `screenReply`.
- `docs/` is public user documentation. Keep commands generic and never add local absolute paths.

## Architecture and session flow

- Short tap -> authenticated `GET /session?v=2` -> single-use ticket -> `wss` to our `/talk` -> binary PCM up -> Worker transcribes, answers, screens, synthesizes -> binary PCM down -> `{"t":"done"}` -> short tap closes with code `1000`.
- `/session` without `v=2` still returns an ElevenLabs signed URL, so deploying the Worker cannot strand a board running older firmware. There is no OTA; recovery is a USB cable.
- Topic ids reach storage only through the `note_topic` tool's enum, never as free text -> `/progress` -> NVS cache -> swipe-left curiosity map.
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
- Never persist audio, summaries, rationales, or arbitrary child text beyond the live session. Conversation history is session-scoped: it lives in the Durable Object so a reconnect does not lose the thread, and is dropped when the socket closes. Long-lived storage holds only normalized IDs, local dates, aggregate counts, revision, latest topic, and short-lived conversation-ID deduplication data.
- Keep progress HTTP/NVS work outside LVGL and the audio pipeline. Failed or malformed refreshes leave the last valid cache intact.

## Audio invariants

- PCM is always 16 kHz, signed 16-bit, mono in both directions. Chirp3-HD is asked for 16 kHz LINEAR16 directly, so nothing is resampled.
- Audio travels as raw PCM in binary frames; control messages are `{"t": ...}` text frames under 4 KB. Do not reintroduce base64-in-JSON audio.
- Keep half duplex: upload microphone PCM only while listening, and upload nothing while buffering, playing, or flushing. The old equal-duration zero PCM existed to keep a third-party timeline aligned; our Worker owns turn detection, so silence on the wire is silence.
- Playback ends only after the `{"t":"done"}` frame and an empty playback queue. Packet gaps are not response boundaries.
- Keep `PREBUFFER` in `firmware/main/pipeline.c` as a hardware calibration knob. The current `48,000` bytes is the measured 1.5-second setting.
- Every use of `s_ws` goes through `s_ws_lock`, and teardown nulls it while holding that lock. Destroying the client under a blocked `tx_task` panics with `LoadProhibited`, which reboots the board and wedges a display that has no reset line.
- Keep automatic WebSocket reconnect disabled because a session ticket is single-use.

## Safety and privacy rules

- Default agent configuration is `private blocking`; diagnostics records voice for seven days and must be an explicit temporary choice.
- Zero-day scheduled deletion is not ElevenLabs Enterprise Zero Retention Mode. Make no legal-compliance claim.
- Child name, age, grammatical form, voice ID, API keys, agent ID, device token, Worker URL, and webhook secret are private configuration.
- Keep visible listening/buffering/playback states and tap-to-listen behavior.
- Do not add child transcripts, recordings, identifying examples, or live service identifiers to tests, fixtures, logs, documentation, or commits.

## Generated files and secrets

- Keep Worker secrets only in `worker/.dev.vars` or Cloudflare secrets. Never print or commit them.
- A Google service account JSON contains a private key. `.gitignore` covers the downloaded `<project>-<hash>.json` name; upload it with `wrangler secret put GCP_SERVICE_ACCOUNT` and never commit a copy.
- Copy `firmware/main/wifi_creds.h.example` to ignored `firmware/main/wifi_creds.h`. Never commit the real file.
- Commit `firmware/dependencies.lock` for reproducible board builds, but regenerate it through ESP-IDF rather than editing it by hand.
- Do not edit or commit `firmware/build/`, `firmware/managed_components/`, generated `firmware/sdkconfig*`, `worker/.wrangler/`, `node_modules/`, caches, or audio fixtures.

## Required verification

- Run the smallest relevant tests, then all Worker checks for Worker changes and a clean ESP-IDF build for firmware changes.
- After a firmware build, require `git diff --exit-code -- firmware/dependencies.lock`.
- For user-visible firmware changes, verify the real V2 device: tap, states, authenticated session, 16 kHz PCM, complete playback, the `{"t":"done"}` frame, and close code `1000`.
- A blank display is a panic until the monitor says otherwise, and the panel has no reset line: power-cycle over USB before concluding anything about a build.
- Run the host conversation test only with a maintainer-supplied WAV and `progress=0`; run all four safety cases after agent changes.
- Before publication, scan staged files for secrets, personal identifiers, live URLs, absolute paths, audio, generated folders, and caches.
