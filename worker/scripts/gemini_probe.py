#!/usr/bin/env python3
"""Maintainer-only: measure whether a Gemini Live migration is actually cheaper.

Gemini re-bills the whole accumulated audio context on every turn, so cost
scales with turn count rather than conversation length. ElevenLabs bills
wall-clock seconds. Which wins depends entirely on how chatty the child is,
and that is the one number we cannot get from the ElevenLabs records because
transcripts are deleted for privacy. This measures it directly.

Usage:
  python3 scripts/gemini_probe.py --list-models
  python3 scripts/gemini_probe.py --probe question.wav --turns 12
  python3 scripts/gemini_probe.py --tts "שלום, איך קוראים לך?" --out voice.wav

Needs GEMINI_API_KEY in .dev.vars and the pinned websockets package.
Nothing here touches the live ElevenLabs agent or the curiosity map.
"""
import argparse
import asyncio
import base64
import json
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
HOST = "generativelanguage.googleapis.com"
CHUNK = 8000                      # 250 ms of 16 kHz mono signed 16-bit PCM

# Measured ElevenLabs baseline for comparison (see the billing analysis).
ELEVEN_USD_PER_MIN = 0.079
# Live native-audio rates, USD per 1M tokens. Audio is 25 tokens/second.
PRICE = {"audio_in": 3.00, "text_in": 0.50, "audio_out": 12.00, "text_out": 2.00}


def dev_var(name):
    path = ROOT / ".dev.vars"
    if not path.exists():
        sys.exit("copy .dev.vars.example to .dev.vars first")
    for line in path.read_text().splitlines():
        if line.startswith(name + "="):
            value = line.split("=", 1)[1].strip()
            if value:
                return value
    sys.exit(f"{name} missing from .dev.vars")


def read_wav(path):
    if not path.exists():
        sys.exit(f"no such file: {path}")
    with wave.open(str(path), "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            sys.exit("wav must be 16 kHz, mono, signed 16-bit "
                     f"(got {w.getframerate()} Hz, {w.getnchannels()}ch, "
                     f"{w.getsampwidth() * 8}-bit)")
        return w.readframes(w.getnframes())


def api(path, payload=None):
    """REST call. The key rides in a header so it never lands in a URL or log."""
    url = f"https://{HOST}/v1beta/{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"x-goog-api-key": dev_var("GEMINI_API_KEY"),
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} failed: {e.code} {e.read().decode()[:400]}")


def list_models():
    models = api("models").get("models", [])
    live = [m for m in models if "bidiGenerateContent" in m.get(
        "supportedGenerationMethods", [])]
    tts = [m for m in models if "tts" in m["name"].lower()]
    print(f"key works; {len(models)} models visible\n")
    print("Live (bidiGenerateContent) — usable for the conversation path:")
    for m in live or [{"name": "  (none found)"}]:
        print("  ", m["name"])
    print("\nTTS — usable for the separate-synthesis path:")
    for m in tts or [{"name": "  (none found)"}]:
        print("  ", m["name"])


def synthesize(text, model, out):
    """Hebrew voice check. Separate synthesis is what keeps a blocking safety
    screen possible: we hold the text, judge it, and only then speak."""
    body = {"contents": [{"parts": [{"text": text}]}],
            "generationConfig": {"responseModalities": ["AUDIO"]}}
    resp = api(f"models/{model}:generateContent", body)
    try:
        part = resp["candidates"][0]["content"]["parts"][0]["inlineData"]
    except (KeyError, IndexError):
        sys.exit(f"no audio in response: {json.dumps(resp)[:400]}")
    pcm = base64.b64decode(part["data"])
    rate = 24000
    for field in part.get("mimeType", "").split(";"):
        if field.strip().startswith("rate="):
            rate = int(field.split("=", 1)[1])
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    print(f"wrote {out}: {len(pcm) / 2 / rate:.1f}s at {rate} Hz "
          f"({len(text)} chars). Listen before trusting it with a 5-year-old.")


def usage_by_modality(meta, field):
    out = {}
    for entry in meta.get(field, []) or []:
        out[entry.get("modality", "?")] = entry.get("tokenCount", 0)
    return out


async def probe(wav, turns, model, system):
    """Replay one utterance N times and watch what each turn is billed.

    The point is the *shape* of the curve. If prompt tokens climb steeply with
    turn count, cumulative-context re-billing dominates and a chatty child makes
    Gemini more expensive than ElevenLabs, not less.
    """
    pcm = read_wav(wav)
    url = (f"wss://{HOST}/ws/google.ai.generativelanguage.v1beta."
           f"GenerativeService.BidiGenerateContent")
    setup = {"setup": {
        "model": f"models/{model}",
        # TEXT out, not AUDIO: this is the shape that lets us screen a reply
        # before it is spoken, which Live cannot do otherwise (it has no
        # safetySettings support at all).
        "generationConfig": {"responseModalities": ["TEXT"]},
        "systemInstruction": {"parts": [{"text": system}]},
        "inputAudioTranscription": {},
    }}

    rows = []
    async with websockets.connect(
            url, additional_headers={"x-goog-api-key": dev_var("GEMINI_API_KEY")},
            max_size=None) as ws:
        await ws.send(json.dumps(setup))
        raw = await ws.recv()
        if "setupComplete" not in raw:
            sys.exit(f"setup rejected: {raw[:400]}")
        print(f"connected: {model}, audio in / text out\n")

        for turn in range(1, turns + 1):
            for i in range(0, len(pcm), CHUNK):
                await ws.send(json.dumps({"realtimeInput": {"audio": {
                    "mimeType": "audio/pcm;rate=16000",
                    "data": base64.b64encode(pcm[i:i + CHUNK]).decode()}}}))
            await ws.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))

            reply, meta = "", {}
            while True:
                msg = json.loads(await ws.recv())
                meta = msg.get("usageMetadata", meta)
                server = msg.get("serverContent", {})
                for part in server.get("modelTurn", {}).get("parts", []):
                    reply += part.get("text", "")
                if server.get("turnComplete"):
                    break
            rows.append((turn, meta.get("promptTokenCount", 0),
                         meta.get("responseTokenCount", 0),
                         usage_by_modality(meta, "promptTokensDetails")))
            print(f"turn {turn:>2}: prompt={rows[-1][1]:>7,}  "
                  f"response={rows[-1][2]:>5,}  {reply[:60]}")

    report(rows, len(pcm))


def report(rows, pcm_bytes):
    if not rows:
        return
    audio_s = pcm_bytes / 2 / 16000
    total = 0.0
    print(f"\nutterance {audio_s:.1f}s; each turn re-bills whatever context "
          f"has accumulated\n")
    print(f"{'turn':>4} {'prompt tok':>11} {'Δ vs prev':>10} {'turn USD':>10} "
          f"{'cumulative':>11}")
    for i, (turn, prompt, resp, _) in enumerate(rows):
        # prompt tokens are dominated by accumulated audio; price them as audio
        usd = prompt * PRICE["audio_in"] / 1e6 + resp * PRICE["text_out"] / 1e6
        total += usd
        delta = prompt - rows[i - 1][1] if i else prompt
        print(f"{turn:>4} {prompt:>11,} {delta:>+10,} {usd:>10.5f} {total:>11.5f}")

    wall_min = len(rows) * (audio_s + 6) / 60      # ~6s of reply+pause per turn
    eleven = wall_min * ELEVEN_USD_PER_MIN
    print(f"\n{len(rows)} turns ~= {wall_min:.1f} min of conversation")
    print(f"  gemini     ${total:.4f}")
    print(f"  elevenlabs ${eleven:.4f}   (measured {ELEVEN_USD_PER_MIN}/min)")
    if eleven > 0:
        print(f"  => {'saving' if total < eleven else 'LOSS'} "
              f"{abs(1 - total / eleven) * 100:.0f}%")
    print("\nRe-run with more turns. If the saving shrinks as turns rise, "
          "cumulative-context re-billing is the deciding factor and a chatty "
          "child erases the win.")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--list-models", action="store_true")
    p.add_argument("--probe", metavar="WAV", help="16 kHz mono WAV to replay")
    p.add_argument("--turns", type=int, default=12)
    p.add_argument("--model", default="gemini-2.5-flash-native-audio-preview-12-2025")
    p.add_argument("--tts", metavar="TEXT", help="synthesize Hebrew and save it")
    p.add_argument("--tts-model", default="gemini-2.5-flash-preview-tts")
    p.add_argument("--out", default="voice.wav")
    p.add_argument("--system", default="אתה חבר הרפתקאות של ילד בן חמש. "
                   "ענה בעברית פשוטה, שניים עד שלושה משפטים קצרים.")
    args = p.parse_args()

    if args.list_models:
        list_models()
    elif args.tts:
        synthesize(args.tts, args.tts_model, args.out)
    elif args.probe:
        asyncio.run(probe(Path(args.probe), args.turns, args.model, args.system))
    else:
        p.print_help()


if __name__ == "__main__":
    main()
