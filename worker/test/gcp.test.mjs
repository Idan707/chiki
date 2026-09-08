import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_VOICE, LANGUAGE, RATE, WAV_HEADER_BYTES, b64url, parseServiceAccount,
  pemToDer, speechBody,
} from '../src/gcp.mjs';

test('b64url is url-safe and unpadded', () => {
  assert.equal(b64url('hello'), 'aGVsbG8');
  assert.ok(!b64url(new Uint8Array([251, 255, 254])).match(/[+/=]/));
});

test('a PEM private key converts to DER', () => {
  const der = pemToDer('-----BEGIN PRIVATE KEY-----\nAAEC\n-----END PRIVATE KEY-----\n');
  assert.deepEqual([...new Uint8Array(der)], [0, 1, 2]);
});

test('an incomplete service account is rejected before any network call', () => {
  assert.throws(() => parseServiceAccount('{"client_email":"a@b"}'), /private_key/);
  assert.throws(() => parseServiceAccount({ private_key: 'k', token_uri: 'u' }), /client_email/);
});

// The codec runs at 16 kHz; asking for it here means nothing needs resampling,
// unlike Gemini TTS which only answers at 24 kHz.
test('synthesis is requested at the rate the device already plays', () => {
  const body = speechBody('שלום');
  assert.equal(body.audioConfig.sampleRateHertz, RATE);
  assert.equal(RATE, 16000);
  assert.equal(body.audioConfig.audioEncoding, 'LINEAR16');
  assert.equal(body.voice.languageCode, LANGUAGE);
  assert.ok(body.voice.name.startsWith('he-IL-Chirp3-HD-'));
});

test('the voice is overridable', () => {
  assert.equal(speechBody('שלום', 'he-IL-Chirp3-HD-Aoede').voice.name, 'he-IL-Chirp3-HD-Aoede');
  assert.equal(speechBody('שלום').voice.name, DEFAULT_VOICE);
});

test('the RIFF header is accounted for', () => {
  assert.equal(WAV_HEADER_BYTES, 44);
});
