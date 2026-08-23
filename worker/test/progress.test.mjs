import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  hasSubstantiveExchange, jerusalemDay, normalizeTopics, progressSnapshot, recordProgress,
  progressEvent, verifyElevenLabsSignature,
} from '../src/progress.mjs';

globalThis.crypto ||= webcrypto;

test('normalizes only known unique topics', () => {
  assert.deepEqual(normalizeTopics('space, weather,space, made_up, other'), ['space', 'weather', 'other']);
  assert.deepEqual(normalizeTopics({ value: 'jungle' }), ['jungle']);
  assert.deepEqual(normalizeTopics(null), []);
});

test('requires a meaningful child turn followed by a topical response', () => {
  assert.equal(hasSubstantiveExchange([
    { role: 'agent', message: 'רוצה לצאת למשימת חלל קטנה?' },
    { role: 'user', message: 'היי' },
    { role: 'agent', message: 'היי, איזה כיף לשמוע אותך!' },
  ]), false);
  assert.equal(hasSubstantiveExchange([
    { role: 'user', message: 'למה הירח משנה צורה?' },
    { role: 'agent', message: 'הירח לא באמת משנה צורה; אנחנו רואים בכל לילה חלק אחר שמואר מהשמש.' },
  ]), true);
  assert.equal(hasSubstantiveExchange([
    { role: 'user', message: 'תסביר לי משהו מסוכן' },
    { role: 'agent', message: 'על זה אני לא יכול לעזור, אבל אפשר לדבר על משהו בטוח וכיפי.' },
  ]), false);
});

test('accepts only enabled, completed Chiki transcription fixtures', () => {
  const event = {
    type: 'post_call_transcription', event_timestamp: 1_800_000_000,
    data: {
      agent_id: 'kidbot', conversation_id: 'conversation-1', status: 'done',
      transcript: [
        { role: 'user', message: 'למה הירח משנה צורה?' },
        { role: 'agent', message: 'אנחנו רואים חלקים שונים של הצד המואר של הירח לאורך החודש.' },
      ],
      analysis: { data_collection_results: { explored_topics: { value: 'space,bogus' } } },
      conversation_initiation_client_data: { dynamic_variables: { progress_enabled: true } },
    },
  };
  assert.deepEqual(progressEvent(event, 'kidbot')?.topics, ['space']);
  assert.equal(progressEvent(event, 'another-agent'), null);
  assert.equal(progressEvent({ ...event, type: 'post_call_audio' }, 'kidbot'), null);
  event.data.conversation_initiation_client_data.dynamic_variables.progress_enabled = false;
  assert.equal(progressEvent(event, 'kidbot'), null);
});

test('deduplicates conversations and topic-days while keeping lifetime progress', () => {
  const at = Date.parse('2026-08-23T12:00:00Z');
  let result = recordProgress(null, 'conv-1', at, ['space']);
  assert.equal(result.changed, true);
  assert.equal(result.state.lifetime_explorations, 1);
  result = recordProgress(result.state, 'conv-1', at, ['weather']);
  assert.equal(result.duplicate, true);
  result = recordProgress(result.state, 'conv-2', at, ['space', 'weather']);
  assert.equal(result.state.lifetime_explorations, 2);
  assert.deepEqual(result.state.lifetime_topics.sort(), ['space', 'weather']);
});

test('builds a Sunday-aligned 84-cell calendar capped at intensity four', () => {
  const at = Date.parse('2026-08-23T12:00:00Z');
  const day = jerusalemDay(at);
  const state = {
    revision: 3,
    days: { [day]: ['space', 'weather', 'jungle', 'oceans', 'other'] },
    lifetime_topics: ['space', 'weather'], lifetime_explorations: 5, latest_topic: 'weather',
  };
  const snapshot = progressSnapshot(state, at);
  assert.equal(snapshot.days.length, 84);
  assert.equal(snapshot.today_index, 77);
  assert.equal(snapshot.days[snapshot.today_index], 4);
  assert.equal(snapshot.week_start, '2026-06-07');
});

test('uses Jerusalem rather than UTC date boundaries', () => {
  assert.equal(jerusalemDay(Date.parse('2026-01-01T22:30:00Z')), '2026-01-02');
  assert.equal(jerusalemDay(Date.parse('2026-07-01T21:30:00Z')), '2026-07-02');
});

test('verifies ElevenLabs HMAC and rejects stale or changed payloads', async () => {
  const raw = '{"type":"post_call_transcription"}';
  const secret = 'test-secret';
  const timestamp = 1_800_000_000;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)));
  const hex = [...signed].map((b) => b.toString(16).padStart(2, '0')).join('');
  const header = `t=${timestamp},v0=${hex}`;
  assert.equal(await verifyElevenLabsSignature(raw, header, secret, timestamp * 1000), true);
  assert.equal(await verifyElevenLabsSignature(`${raw} `, header, secret, timestamp * 1000), false);
  assert.equal(await verifyElevenLabsSignature(raw, header, secret, (timestamp + 301) * 1000), false);
});
