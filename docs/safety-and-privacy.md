# Safety and privacy

Kidbot is experimental software for an adult to build and supervise. It is not a certified toy, medical device, emergency service, educational authority, or substitute for a parent or guardian. This document describes implementation choices; it makes no legal-compliance claim.

## Interaction defaults

- A physical tap starts listening; another tap ends the conversation.
- The screen visibly distinguishes listening, buffering, and playback.
- There is no intended always-listening mode.
- Chiki is prompted not to request identifying information, keep secrets from caregivers, provide dangerous instructions, or give medical/legal advice.
- Safety defaults are `private blocking`: prompt/focus protections enabled, content guardrails blocking with a safe retry, recording disabled, and scheduled deletion requested at zero days.

Automated guardrails can fail. An adult must test the configured voice agent, supervise use, and decide whether this project is appropriate for their child and jurisdiction.

## Cloud data flow

```text
device -- bearer token --> Cloudflare Worker -- signed URL --> device
device <============== live audio/events ==============> ElevenLabs
ElevenLabs -- signed post-call webhook --> Worker Durable Object
device -- bearer token --> Worker /progress --> local NVS cache
```

Cloudflare processes authentication, session counters, and normalized progress. ElevenLabs processes live audio, transcription, agent inference, synthesized speech, and configured post-call analysis. Your network provider and hosting region may add other processing paths. Review the providers' current terms, data locations, subprocessors, and account settings before use.

## What Kidbot stores

The Worker progress store is intentionally narrow: normalized topic IDs, Jerusalem-local dates, aggregate counts, a revision, the latest topic, and short-lived conversation-ID hashes for deduplication. Only the fixed allowlist in `worker/src/progress.mjs` is accepted.

The Worker does **not** persist webhook transcripts, audio, summaries, rationales, or arbitrary child text. The device NVS cache holds the compact progress view and preserves the last valid snapshot if refresh fails.

## Recording and retention modes

`./scripts/configure_agent.sh` defaults to `private blocking`:

| Mode | Voice recording | Requested retention | Use |
|---|---:|---:|---|
| `private` | off | zero-day scheduled deletion | Normal supervised use |
| `diagnostics` | on | seven days | Short, deliberate troubleshooting only |

Zero-day scheduled deletion is **not** [ElevenLabs Enterprise Zero Retention Mode](https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention). The conversation must still be processed, deletion behavior depends on the provider configuration, and existing conversations are never changed by the script. Disable diagnostics as soon as troubleshooting ends.

## Parent and maintainer responsibilities

Before use:

1. Use a private child name/profile and never commit it.
2. Inspect the live ElevenLabs privacy, retention, guardrail, voice, and webhook settings.
3. Run all four safety acceptance cases in `private blocking`.
4. Explain the listening indicator and tap controls to the child.
5. Supervise real conversations and have a plan for harmful, surprising, or emergency content.
6. Rotate secrets and stop service access if a device is lost.

Useful regulatory design references include the [FTC COPPA rule](https://www.ftc.gov/system/files/ftc_gov/pdf/coppa_sbp_1.16_0.pdf) and the UK ICO's [best-interests framework for connected toys and devices](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/how-to-use-our-guidance-for-standard-one-best-interests-of-the-child/best-interests-framework/processing-data-through-connected-toys-and-devices/). They are starting points for qualified advice, not evidence that this project complies with any law.

## Reporting a security or safety issue

Do not publish vulnerabilities, exposed child data, transcripts, recordings, or secrets in a GitHub issue. Use [GitHub private vulnerability reporting](https://github.com/Idan707/kidbot/security/advisories/new). See [SECURITY.md](../SECURITY.md).
