# Architecture

Chiki separates local interaction, session authorization, cloud conversation, and deliberately tiny progress storage. Firmware owns the physical experience; the Worker owns trust boundaries and rate limits; ElevenLabs handles live ASR, agent inference, and TTS.

## Conversation path

```text
 short tap
    |
    v
+-----------+   authenticated GET /session   +------------+
| ESP32-S3  | ------------------------------> | CF Worker  |
| firmware  | <------------------------------ | cap+ticket |
+-----+-----+     ticketed wss URL            +------+-----+
      |                                                 |
      | binary PCM up / binary PCM down                 |
      +-------------------------------------------------+
                                                        |
      +-------------------------------------------------+
      v            v              v               v
   transcribe -> answer -> screen the reply -> synthesise
      |
      +-- {"t":"done"} + empty queue --> idle
      +-- short tap --------------------> close 1000
```

1. A short tap asks the Worker for `GET /session` using the device bearer token.
2. The Worker fails closed if secrets or limits are invalid, increments a strongly consistent Durable Object counter, and mints a single-use session ticket.
3. The Worker returns a ticketed `wss://` URL as `signed_url`. Responses are `no-store`.
4. Firmware opens that socket and sends nothing: the Worker already holds this session's adventure against the ticket, so it opens the conversation itself.
5. The Worker runs the whole loop — transcribe, answer, screen the reply, synthesise — so no provider key ever reaches the device, and the reply is judged as text *before* it is spoken.
6. Playback is complete only after `{"t":"done"}` and an empty playback queue. Network packet gaps are not boundaries.
7. A short tap ends the socket with WebSocket close code `1000`. Automatic reconnect is disabled because a session ticket is single-use.

### Device/Worker frame protocol

Audio is raw PCM in **binary** frames in both directions: 16 kHz, signed
16-bit, mono. No base64, no JSON wrapper — that removes 33% inflation on the
wire and the two multi-megabyte scratch buffers the previous protocol needed.
The Worker resamples synthesis down to 16 kHz so the device never sees another
sample rate.

Control messages are small **text** frames, `{"t": ...}`, capped at 4 KB:

| Direction | Frame | Meaning |
|---|---|---|
| Worker → device | `{"t":"ready","id":"..."}` | session open |
| Worker → device | `{"t":"thinking","text":"..."}` | child's turn ended; `text` is for the log only |
| Worker → device | `{"t":"speaking","text":"..."}` | reply passed the safety screen; audio follows |
| Worker → device | `{"t":"done"}` | end of agent turn; return to listening |
| Worker → device | `{"t":"bye","why":"..."}` | Worker is ending the session |
| device → Worker | binary | microphone PCM, while listening only |

The Worker owns turn detection. The device streams continuously while
listening and stops entirely while buffering or playing, which keeps the
half-duplex guarantee without uploading zero PCM.

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

The Durable Object stores normalized IDs, Jerusalem-local dates, aggregate counts, revision, latest topic, and short-lived conversation-ID deduplication data. It never stores webhook transcripts, audio, summaries, rationales, or arbitrary child text. The device presents a rolling, Sunday-aligned 84-day view, with at most four distinct topic markers per day and no scores, streaks, missed-day pressure, or mastery claims.

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
- Public errors are generic; upstream response details appear only in server logs.
- Credentials are local or Worker secrets, never Wrangler variables or source code.
- This is a single-device-oriented experimental design. Multi-household tenancy, account provisioning, remote revocation, and fleet management are outside v0.1.0.
