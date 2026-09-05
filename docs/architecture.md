# Architecture

Chiki separates local interaction, session authorization, cloud conversation, and deliberately tiny progress storage. Firmware owns the physical experience; the Worker owns trust boundaries and rate limits; ElevenLabs handles live ASR, agent inference, and TTS.

## Conversation path

```text
 short tap
    |
    v
+-----------+   authenticated GET /session   +------------+
| ESP32-S3  | ------------------------------> | CF Worker  |
| firmware  | <------------------------------ | cap + vars |
+-----+-----+     signed URL + adventure      +------+-----+
      |                                                 |
      | signed WebSocket                                | mint
      v                                                 v
+-------------------------------------------------------------+
| ElevenLabs agent: 16 kHz PCM -> ASR -> AI -> TTS -> audio  |
+-------------------------------------------------------------+
      |
      +-- agent_response_complete + empty queue --> listening
      +-- short tap ------------------------------> close 1000
```

1. A short tap asks the Worker for `GET /session` using the device bearer token.
2. The Worker fails closed if secrets or limits are invalid, increments a strongly consistent Durable Object counter, and asks ElevenLabs for a signed WebSocket URL.
3. The Worker returns `signed_url` and `dynamic_variables` at the top level. Responses are `no-store`.
4. Firmware opens the signed socket and sends initialization variables.
5. Microphone input is 16 kHz signed 16-bit mono PCM. During buffering, playback, and microphone flushing, the device uploads equal-duration zero PCM to preserve timing without feedback.
6. Playback is complete only after `agent_response_complete` and an empty playback queue. Network packet gaps are not boundaries.
7. A short tap ends the socket with WebSocket close code `1000`. Automatic reconnect is disabled because a signed raw conversation cannot be resumed safely.

Session JSON is read completely across HTTP fragments. Missing or oversized dynamic variables fail the session instead of silently dropping the adventure or progress settings. A ten-second audio stall without `agent_response_complete` closes the session; it is never interpreted as successful completion.

Opening lines vary with time since the last session started. Only webhook-confirmed exploration can supply the previous topic; merely offering an adventure does not create a memory of exploring it.

## Curiosity-map path

```text
 ElevenLabs post-call analysis
              |
              | signed transcription webhook
              v
       +--------------+    normalized IDs    +----------------+
       | CF Worker    | --------------------> | SessionCounter |
       | HMAC + rules |                       | Durable Object |
       +------+-------+                       +-------+--------+
              ^                                       |
              | authenticated GET /progress           |
              +---------------- ESP32-S3 <-------------+
                                   |
                                   v
                         NVS cache -> swipe-left map
```

The webhook body is bounded and HMAC verified before parsing. Only these identifiers may cross into storage: `space`, `jungle`, `detectives`, `oceans`, `dinosaurs`, `inventors`, `human_body`, `ancient_egypt`, `insects`, `weather`, and `other`.

The Worker receives the full transcript and analysis in memory, then the Durable Object stores normalized IDs, Jerusalem-local dates, aggregate counts, revision, latest topic, and short-lived opaque conversation IDs for deduplication. It never persists webhook transcripts, audio, summaries, rationales, or arbitrary child text. A daily Durable Object alarm removes expired conversation IDs and day-level history outside the current calendar; lifetime totals and latest topic remain. The device presents a rolling, Sunday-aligned 84-day view, with at most four distinct topic markers per day and no scores, streaks, missed-day pressure, or mastery claims.

Progress HTTP and NVS work stays outside LVGL and the audio pipeline. A failed or malformed refresh leaves the last valid device cache intact. Host conversation tests call `/session?progress=0` so test calls do not alter the map.

## Repository boundaries

```text
firmware/main/     display, touch, codec, network, audio pipeline, map
worker/src/        HTTP trust boundaries and pure progress rules
worker/test/       Node built-in tests for progress normalization/storage
worker/scripts/    maintainer-only cloud configuration and acceptance tools
docs/              public build, architecture, and safety guidance
```

## Security properties and limits

- Device routes require a bearer token; webhook input requires an ElevenLabs HMAC signature.
- `/session` has a positive validated daily cap backed by one Durable Object.
- Public errors are generic; server logs contain status codes, not upstream bodies, prompts, or credentials.
- Signed URLs are reusable until expiry. The cap limits issuance, not total billed minutes; configure provider-side limits too.
- Credentials are local or Worker secrets, never Wrangler variables or source code.
- This is a single-device-oriented experimental design. Multi-household tenancy, account provisioning, remote revocation, and fleet management are outside v0.1.0.
