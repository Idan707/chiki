<p align="center">
  <img src="docs/assets/kidbot-hero.png" alt="Concept artwork of a small cyan-faced voice companion in a playful retro terminal landscape" width="100%">
</p>

# Chiki

[![CI](https://github.com/Idan707/chiki/actions/workflows/ci.yml/badge.svg)](https://github.com/Idan707/chiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)
[![Status: experimental](https://img.shields.io/badge/status-experimental-violet.svg)](docs/safety-and-privacy.md)

> **Ask. Wonder. Go explore.**

Chiki is an experimental, tap-to-talk Hebrew voice companion. It runs on the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2, streams audio directly to an ElevenLabs conversational agent, and turns conversations into small, safe invitations to explore the real world.

*The banner is concept artwork, not a hardware diagram. See the [hardware guide](docs/hardware.md) for the exact board.*

> [!WARNING]
> Chiki is an experimental source release, not a certified toy or a substitute for adult supervision. A parent or guardian must configure, supervise, and evaluate it before a child uses it.

## What Chiki does

- Starts and ends a conversation with a short tap.
- Shows visible listening, buffering, and playback states.
- Streams 16 kHz signed 16-bit mono PCM over a signed WebSocket.
- Speaks Hebrew using a privately configured child profile and voice.
- Suggests short, age-appropriate offline curiosity activities.
- Shows an 84-day curiosity map containing only normalized topic IDs—never scores, streaks, transcripts, or child-authored text.

## How it fits together

<div align="center">
<pre align="center">
+--------------------------------------------------------------------+
|                         CHIKI SIGNAL MAP                           |
|                                                                    |
|                           .----------.                             |
|                          /  o      o  \                            |
|                         |      /\      |                           |
|                         |    \____/    |                           |
|                          \____________/                            |
|                          CHIKI / ESP32-S3                          |
|                                                                    |
| +--------------+  GET /session  +-------------------------+        |
| | CHIKI        |  ------------&gt; | CLOUDFLARE WORKER       |        |
| | ESP32-S3     |  &lt;------------ | auth / cap / adventure  |        |
| +------+-------+   signed URL   +-------------+-----------+        |
|        |                                      |                    |
|        | direct WebSocket                     | mint URL           |
|        +--------------------+-----------------+                    |
|                             v                                      |
|                   +--------------------+                           |
|                   | ELEVENLABS AGENT   |                           |
|                   | ASR + AI + TTS     |                           |
|                   +--------------------+                           |
|                                                                    |
|             16 kHz PCM up / audio + events down                    |
+--------------------------------------------------------------------+
</pre>
</div>

In words: the device authenticates to a small Cloudflare Worker, which caps signed-URL requests and returns a short-lived ElevenLabs WebSocket URL plus the current adventure. Audio then travels directly between the device and ElevenLabs. After a call, a signed webhook sends the transcript and analysis to the Worker. The Worker processes them in memory and stores only normalized progress; the device fetches that compact map separately.

Read the full [architecture](docs/architecture.md), [hardware](docs/hardware.md), and [safety and privacy](docs/safety-and-privacy.md) guides.

## Supported hardware

The verified target is the **Waveshare ESP32-S3-Touch-AMOLED-1.8 V2**, using its onboard microphone, speaker codec, AMOLED display, touch controller, and USB-C connection. V1 is unverified because Waveshare documents different V1/V2 display and touch controllers.

No public firmware binary is provided: Wi-Fi and device credentials are currently compiled into each device. Build from source after creating your local credentials file.

## Prerequisites and costs

You need:

- the supported V2 board and a data-capable USB-C cable;
- [ESP-IDF 5.5.4](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/get-started/);
- Node.js 24 and npm;
- Python 3.11+, `ffmpeg`, `curl`, `jq`, and ShellCheck for all host checks;
- Cloudflare Workers and ElevenLabs accounts.

Cloudflare and ElevenLabs may charge for usage. Review their current pricing and data-processing terms before enabling a device. The daily cap limits URL issuance, not total billed minutes: [signed URLs can be reused until they expire](https://elevenlabs.io/docs/eleven-agents/customization/authentication). Set provider-side spending and concurrency limits too. Chiki has no automatic deployment and CI never deploys production.

## Quick start

### 1. Clone and configure the device

```sh
git clone https://github.com/Idan707/chiki.git
cd chiki
cp firmware/main/wifi_creds.h.example firmware/main/wifi_creds.h
```

Fill in the ignored `wifi_creds.h`. Generate a strong device token, for example with `openssl rand -hex 32`, and use the same value as the Worker's `DEVICE_TOKEN` secret.

### 2. Configure the Worker and agent

```sh
cp worker/.dev.vars.example worker/.dev.vars
cd worker
npm ci
npm test
npx wrangler login
npx wrangler deploy
```

The first deployment serves health checks but refuses sessions until configured. Fill in `.dev.vars` with the deployed HTTPS origin as `WORKER_URL`, your API key, voice, device token, and private child profile. Set the same origin in `wifi_creds.h`. Leave `ELEVEN_AGENT_ID` empty to create a new agent:

```sh
./scripts/configure_agent.sh
```

Save the printed ID as `ELEVEN_AGENT_ID` in `.dev.vars`. Upload only the three Worker secrets, then attach the webhook and verify the agent:

```sh
npx wrangler secret put DEVICE_TOKEN
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVEN_AGENT_ID
./scripts/configure_progress_webhook.sh
./scripts/configure_agent.sh
cd ..
```

The second agent run attaches the signed progress webhook and verifies the live configuration. The default is `private blocking`; use `./scripts/configure_agent.sh diagnostics blocking` only during deliberate debugging. See [safety and privacy](docs/safety-and-privacy.md) before doing that.

### 3. Build, flash, and monitor

```sh
. /path/to/esp-idf-v5.5.4/export.sh
idf.py -C firmware build
idf.py -C firmware -p /dev/your-serial-port flash
idf.py -C firmware -p /dev/your-serial-port monitor
```

Exact setup, calibration, and troubleshooting steps live in [docs/hardware.md](docs/hardware.md).

## Privacy and safety defaults

The normal configuration disables voice recording, requests zero-day scheduled deletion, enables prompt and focus protections, and runs content guardrails in blocking mode with a safe retry. **Zero-day scheduled deletion is not ElevenLabs Enterprise Zero Retention Mode.** Third-party processing still occurs during a cloud conversation.

The progress store accepts only an allowlist of topic IDs and local dates. It rejects arbitrary child text and does not store transcripts, audio, summaries, rationales, scores, streaks, or mastery claims. These are implementation safeguards, not a legal-compliance claim. Read [docs/safety-and-privacy.md](docs/safety-and-privacy.md).

## Repository map

```text
chiki/
├── firmware/         ESP-IDF firmware for the ESP32-S3
├── worker/           Cloudflare Worker, tests, and agent scripts
├── docs/             Architecture, hardware, privacy, and artwork
├── .github/          CI and community templates
├── AGENTS.md         Working rules for coding agents
└── CONTRIBUTING.md   Human contribution guide
```

## Development checks

```sh
cd worker
npm ci
npm test
npm run check
python3 -m py_compile scripts/*.py
for script in scripts/*.sh; do bash -n "$script"; done
shellcheck scripts/*.sh
python3 test/scripts_test.py
cd ..

. /path/to/esp-idf-v5.5.4/export.sh
python3 firmware/test/run_net_test.py
idf.py -C firmware build
git diff --exit-code -- firmware/dependencies.lock
```

Hardware acceptance remains manual because it depends on the real codec, display, touch controller, network, and cloud services. The checklist is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities through the [private security advisory form](https://github.com/Idan707/chiki/security/advisories/new).

## License

Chiki source and repository artwork are available under the [MIT License](LICENSE). Third-party services, hardware, SDKs, and managed components retain their own terms.
