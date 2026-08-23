import assert from 'node:assert/strict';
import test from 'node:test';
import { missingSessionSecrets, parseDailyCap } from '../src/session.mjs';

test('requires all session secrets without exposing their values', () => {
  assert.deepEqual(missingSessionSecrets({
    DEVICE_TOKEN: 'token', ELEVENLABS_API_KEY: '', ELEVEN_AGENT_ID: 'agent',
  }), ['ELEVENLABS_API_KEY']);
  assert.deepEqual(missingSessionSecrets({
    DEVICE_TOKEN: 'token', ELEVENLABS_API_KEY: 'key', ELEVEN_AGENT_ID: 'agent',
  }), []);
});

test('accepts only a positive integer daily cap', () => {
  assert.equal(parseDailyCap(undefined), 20);
  assert.equal(parseDailyCap('7'), 7);
  for (const value of ['0', '-1', '1.5', 'nope']) assert.equal(parseDailyCap(value), null);
});
