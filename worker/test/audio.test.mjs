import assert from 'node:assert/strict';
import test from 'node:test';
import { RATE, Resampler, TURN_DEFAULTS, TurnDetector, rms, toInt16 } from '../src/audio.mjs';

const CHUNK_MS = 100;
const CHUNK = (RATE * CHUNK_MS) / 1000;

function tone(samples, amp, freq = 220, rate = RATE, phase = 0) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * (i + phase)) / rate));
  }
  return out;
}
const quiet = (n) => tone(n, 0.001);
const loud = (n) => tone(n, 0.25);

function feed(det, chunks) {
  let last = 'idle';
  for (const c of chunks) last = det.push(c);
  return last;
}

test('room tone alone never starts a turn', () => {
  const det = new TurnDetector();
  for (let i = 0; i < 60; i++) assert.equal(det.push(quiet(CHUNK)), 'idle');
});

test('a cough is too short to count as speech', () => {
  const det = new TurnDetector();
  assert.equal(det.push(loud(CHUNK * 0.5)), 'idle');   // 50ms, under minSpeechMs
  assert.equal(det.push(quiet(CHUNK)), 'idle');
});

test('speech then a pause ends the turn', () => {
  const det = new TurnDetector();
  assert.equal(feed(det, Array(6).fill(0).map(() => loud(CHUNK))), 'speech');
  const needed = Math.ceil(TURN_DEFAULTS.hangoverMs / CHUNK_MS);
  let result = 'speech';
  for (let i = 0; i < needed; i++) result = det.push(quiet(CHUNK));
  assert.equal(result, 'end');
});

// The reason turn detection lives in the Worker at all: a child who pauses
// mid-sentence must not be cut off, and this is tunable without a reflash.
test('a short thinking pause does not end the turn', () => {
  const det = new TurnDetector();
  feed(det, Array(6).fill(0).map(() => loud(CHUNK)));
  const pause = Math.floor(TURN_DEFAULTS.hangoverMs / CHUNK_MS) - 2;
  assert.equal(feed(det, Array(pause).fill(0).map(() => quiet(CHUNK))), 'speech');
  assert.equal(det.push(loud(CHUNK)), 'speech');       // he carries on
});

test('a long ramble still gets answered', () => {
  const det = new TurnDetector();
  const chunks = Math.ceil(TURN_DEFAULTS.maxUtteranceMs / CHUNK_MS) + 2;
  let result = 'idle';
  for (let i = 0; i < chunks && result !== 'end'; i++) result = det.push(loud(CHUNK));
  assert.equal(result, 'end');
});

test('the utterance keeps a lead-in so the first sound is not clipped', () => {
  const det = new TurnDetector();
  det.push(quiet(CHUNK));                 // before he starts
  feed(det, Array(6).fill(0).map(() => loud(CHUNK)));
  const utterance = det.take();
  assert.ok(utterance.length > CHUNK * 6, 'expected pre-trigger audio to be kept');
});

test('take() resets, so the next turn starts clean', () => {
  const det = new TurnDetector();
  feed(det, Array(6).fill(0).map(() => loud(CHUNK)));
  det.take();
  assert.equal(det.push(quiet(CHUNK)), 'idle');
});

test('rms separates silence from speech', () => {
  assert.ok(rms(quiet(CHUNK)) < 0.01);
  assert.ok(rms(loud(CHUNK)) > 0.1);
  assert.equal(rms(new Int16Array(0)), 0);
});

test('resampling 24k to 16k yields two samples for every three', () => {
  const r = new Resampler();
  const out = r.push(tone(2400, 0.5, 300, 24000));
  assert.ok(Math.abs(out.length - 1600) < 40, `got ${out.length}, expected ~1600`);
});

// Naive decimation would fold 8-12 kHz down into the audible band and warble on
// Hebrew sibilants. The low-pass has to actually attenuate it.
test('content above the new Nyquist is attenuated, not folded down', () => {
  const r = new Resampler();
  const out = r.push(tone(24000, 0.9, 10000, 24000));   // 10 kHz, unrepresentable at 16k
  assert.ok(rms(out) < 0.09, `aliased energy too high: ${rms(out).toFixed(3)}`);
});

test('a passband tone survives resampling', () => {
  const r = new Resampler();
  const out = r.push(tone(24000, 0.5, 500, 24000));
  assert.ok(rms(out) > 0.2, `passband was attenuated: ${rms(out).toFixed(3)}`);
});

// Streamed audio arrives in many small frames; phase and filter state must
// carry across them or every seam clicks.
test('chunked resampling matches one-shot resampling', () => {
  const src = tone(7200, 0.5, 440, 24000);
  const oneShot = new Resampler().push(src);

  const streamed = new Resampler();
  const parts = [];
  for (let i = 0; i < src.length; i += 480) parts.push(streamed.push(src.subarray(i, i + 480)));
  const joined = Int16Array.from(parts.flatMap((p) => Array.from(p)));

  assert.ok(Math.abs(joined.length - oneShot.length) <= 2,
    `length drift ${joined.length} vs ${oneShot.length}`);
  const n = Math.min(joined.length, oneShot.length);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(joined[i] - oneShot[i]));
  assert.ok(worst < 900, `seam discontinuity: worst sample delta ${worst}`);
});

test('an odd trailing byte is dropped rather than misaligning the stream', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4]).buffer;
  assert.equal(toInt16(bytes).length, 2);
});
