#!/usr/bin/env python3
"""Maintainer-only host test for the /talk path: one real conversation, timed.

Latency is the open question this stack cannot answer on paper. Transcribe,
answer, screen and synthesize run in sequence, so this measures what a child
would actually wait: tap to first sound, and end-of-speech to first sound of
the reply.

Usage:
  python3 scripts/talk_test.py question.wav [--turns 2] [--out reply.wav]

Always runs with progress=0 so the curiosity map is never touched.
Needs DEVICE_TOKEN and WORKER_URL in .dev.vars and the pinned websockets package.
"""
import argparse
import asyncio
import json
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
RATE = 16000
CHUNK = 4096                       # 128ms of 16 kHz mono, as the device sends


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
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, RATE):
            sys.exit(f"wav must be {RATE} Hz mono 16-bit, got "
                     f"{w.getframerate()} Hz / {w.getnchannels()}ch")
        return w.readframes(w.getnframes())


def session():
    url = dev_var("WORKER_URL").rstrip("/") + "/session?v=2&progress=0"
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + dev_var("DEVICE_TOKEN"),
        "User-Agent": "chiki-test/1.0",   # CF edge rejects urllib's default UA
    })
    with urllib.request.urlopen(req) as response:
        return json.load(response)


async def collect(ws, deadline_s=60):
    """Gather one agent turn. Returns (pcm, first_audio_latency, control)."""
    audio, control, first_at = bytearray(), [], None
    start = time.monotonic()
    while time.monotonic() - start < deadline_s:
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=deadline_s)
        except asyncio.TimeoutError:
            break
        if isinstance(msg, bytes):
            if first_at is None:
                first_at = time.monotonic() - start
            audio.extend(msg)
            continue
        event = json.loads(msg)
        control.append(event)
        if event.get("t") == "done":
            break
        if event.get("t") == "bye":
            print(f"  worker ended the session: {event.get('why')}")
            break
    return bytes(audio), first_at, control


async def run(wav, turns, out):
    pcm = read_wav(wav)
    info = session()
    url = info["signed_url"]
    print(f"ticketed url: {url.split('?')[0]}?t=<ticket>\n")

    tap = time.monotonic()
    replies = []
    async with websockets.connect(url, max_size=None) as ws:
        greeting, greet_first, control = await collect(ws)
        ready = next((c for c in control if c.get("t") == "ready"), {})
        spoke = next((c for c in control if c.get("t") == "speaking"), {})
        print(f"session {ready.get('id', '?')[:8]}")
        print(f"  tap -> first sound   {(greet_first or 0):>6.2f}s")
        print(f"  greeting            {len(greeting) / 2 / RATE:>6.2f}s of audio")
        print(f"  said: {spoke.get('text', '')[:70]}\n")
        replies.append(greeting)

        for turn in range(1, turns + 1):
            for i in range(0, len(pcm), CHUNK):
                await ws.send(pcm[i:i + CHUNK])
                await asyncio.sleep(CHUNK / 2 / RATE)   # stream at real time
            spoke_at = time.monotonic()
            # The Worker's hangover has to elapse before it calls the turn.
            await ws.send(b"\x00\x00" * int(RATE * 1.4))
            reply, first, control = await collect(ws)
            waited = first if first is not None else float('nan')
            spoke = next((c for c in control if c.get("t") == "speaking"), {})
            heard = next((c for c in control if c.get("t") == "thinking"), None)
            print(f"turn {turn}")
            print(f"  end of speech -> first sound  {waited:>6.2f}s   "
                  f"(whole reply delivered in {time.monotonic() - spoke_at:.2f}s)")
            print(f"  turn detected                 {'yes' if heard else 'NO'}")
            print(f"  reply                        {len(reply) / 2 / RATE:>6.2f}s of audio"
                  f"{'  [BLOCKED -> safe line]' if spoke.get('blocked') else ''}")
            print(f"  said: {spoke.get('text', '')[:70]}\n")
            replies.append(reply)

    joined = b"".join(replies)
    if joined:
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(joined)
        print(f"wrote {out}: {len(joined) / 2 / RATE:.1f}s at {RATE} Hz")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("wav", help=f"{RATE} Hz mono WAV to speak")
    p.add_argument("--turns", type=int, default=1)
    p.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "chiki-reply.wav"),
                   help="written outside the repo by default; audio must never be committed")
    a = p.parse_args()
    asyncio.run(run(Path(a.wav), a.turns, a.out))


if __name__ == "__main__":
    main()
