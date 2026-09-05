#!/usr/bin/env python3
"""Host E2E: continuous 16 kHz PCM, explicit response completion, clean close.

Usage: python3 scripts/convai_test.py question.wav [--no-play]
Needs the pinned websockets package and ffmpeg; afplay is used unless skipped.
"""
import asyncio
import base64
import contextlib
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 8000  # 250 ms of 16 kHz, mono, signed 16-bit PCM
SILENCE = b"\0" * CHUNK


def dev_var(name):
    for line in (ROOT / ".dev.vars").read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip()
    sys.exit(f"{name} missing from .dev.vars")


def request_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def session_info():
    return request_json(
        dev_var("WORKER_URL").rstrip("/") + "/session?progress=0",
        {"Authorization": "Bearer " + dev_var("DEVICE_TOKEN"),
         "User-Agent": "kidbot-test/1.0"},  # CF edge rejects urllib's default UA
    )


def pcm16k(wav_path):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", wav_path,
         "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout


def play(pcm, name):
    with tempfile.TemporaryDirectory(prefix="chiki-playback-") as directory:
        out = Path(directory) / f"{name}.wav"
        with wave.open(str(out), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm)
        print(f"[{name}] playing {len(pcm) / 32000:.1f}s")
        subprocess.run(["afplay", str(out)], check=True)


async def send_audio(ws, lock, pcm):
    message = json.dumps({"user_audio_chunk": base64.b64encode(pcm).decode()})
    async with lock:
        await ws.send(message)


async def silence_pump(ws, lock, real_audio):
    while True:
        if not real_audio.is_set():
            await send_audio(ws, lock, SILENCE)
        await asyncio.sleep(CHUNK / 32000)


async def collect_turn(ws, lock, label, metadata, max_s=60):
    audio = bytearray()
    first_audio = None
    deadline = time.monotonic() + max_s
    while time.monotonic() < deadline:
        try:
            message = json.loads(await asyncio.wait_for(ws.recv(), 1.0))
        except asyncio.TimeoutError:
            continue
        event_type = message.get("type")
        if event_type == "audio":
            first_audio = first_audio or time.monotonic()
            audio.extend(base64.b64decode(message["audio_event"]["audio_base_64"]))
        elif event_type == "agent_response_complete":
            if not audio:
                raise AssertionError(f"{label} completed without audio")
            return bytes(audio), first_audio
        elif event_type == "agent_response":
            print(f"[{label}] agent response received")
        elif event_type == "user_transcript":
            print(f"[{label}] user transcript received")
        elif event_type == "ping":
            pong = {"type": "pong", "event_id": message["ping_event"]["event_id"]}
            async with lock:
                await ws.send(json.dumps(pong))
        elif event_type == "conversation_initiation_metadata":
            metadata.update(message["conversation_initiation_metadata_event"])
            print(f"[meta] out={metadata.get('agent_output_audio_format')} "
                  f"in={metadata.get('user_input_audio_format')}")
        else:
            print(f"[{label}] event: {event_type}")
    raise TimeoutError(f"{label} did not emit agent_response_complete within {max_s}s")


async def run(question):
    import websockets

    info = session_info()
    print("[ok] signed URL minted, adventure:", info.get("dynamic_variables"))
    metadata = {}
    greeting = answer = b""
    async with websockets.connect(info["signed_url"], max_size=16 * 1024 * 1024) as ws:
        lock = asyncio.Lock()
        real_audio = asyncio.Event()
        hello = {"type": "conversation_initiation_client_data"}
        if info.get("dynamic_variables"):
            hello["dynamic_variables"] = info["dynamic_variables"]
        await ws.send(json.dumps(hello))
        pump = asyncio.create_task(silence_pump(ws, lock, real_audio))
        try:
            greeting, _ = await collect_turn(ws, lock, "greeting", metadata)

            real_audio.set()
            for offset in range(0, len(question), CHUNK):
                chunk = question[offset:offset + CHUNK]
                await send_audio(ws, lock, chunk)
                await asyncio.sleep(len(chunk) / 32000)
            end_of_speech = time.monotonic()
            await send_audio(ws, lock, SILENCE)
            real_audio.clear()

            answer, first_audio = await collect_turn(ws, lock, "answer", metadata)
            print(f"[latency] end-of-speech -> first audio: {first_audio - end_of_speech:.1f}s")
        finally:
            pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump
        await ws.close(code=1000, reason="host acceptance complete")
        if ws.close_code != 1000:
            raise AssertionError(f"WebSocket closed with {ws.close_code}, expected 1000")

    assert metadata.get("user_input_audio_format") == "pcm_16000", metadata
    assert metadata.get("agent_output_audio_format") == "pcm_16000", metadata
    return greeting, answer, metadata["conversation_id"]


def conversation_details(conversation_id):
    headers = {"xi-api-key": dev_var("ELEVENLABS_API_KEY"),
               "User-Agent": "kidbot-test/1.0"}
    url = f"https://api.elevenlabs.io/v1/convai/conversations/{conversation_id}"
    for _ in range(15):
        details = request_json(url, headers)
        if details.get("status") in {"done", "failed"}:
            return details
        time.sleep(2)
    raise TimeoutError("conversation metadata was not finalized within 30s")


def main():
    positional = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    if len(positional) != 1:
        sys.exit("usage: python3 scripts/convai_test.py question.wav [--no-play]")
    question_path = Path(positional[0])
    if not question_path.is_file():
        sys.exit(f"WAV not found: {question_path}")
    greeting, answer, conversation_id = asyncio.run(run(pcm16k(question_path)))
    details = conversation_details(conversation_id)
    warnings = details.get("metadata", {}).get("warnings", [])
    reason = details.get("metadata", {}).get("termination_reason", "")
    assert not any("Audio duration mismatch" in warning for warning in warnings), warnings
    assert reason.endswith("1000"), reason
    assert greeting and answer
    print("[pass] close=1000 continuity=clean")
    if "--no-play" not in sys.argv:
        play(greeting, "greeting")
        play(answer, "answer")


if __name__ == "__main__":
    main()
