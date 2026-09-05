import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SAFE_LINE, SAFETY_SETTINGS, TOPIC_ENUM, appendTurn, screenReply,
  speechRequest, stripForSpeech, systemPrompt, turnRequest,
} from '../src/talk.mjs';
import { TOPIC_IDS } from '../src/progress.mjs';

const CHILD = { name: 'ילד', age: 5, form: 'masculine' };
const ADVENTURE = {
  weekly_theme: 'מצרים העתיקה',
  today_mission: 'בנה פירמידה קטנה מקוביות.',
  last_topic: 'החלל',
};
const ok = (text, extra = {}) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text }, ...(extra.parts || [])] } }],
});

test('a normal reply is spoken as-is', () => {
  const r = screenReply(ok('עננים הם טיפות מים קטנטנות.'));
  assert.equal(r.blocked, false);
  assert.equal(r.speak, 'עננים הם טיפות מים קטנטנות.');
});

// The point of holding the reply as text: nothing unsafe reaches the speaker.
test('a blocked candidate never reaches the speaker', () => {
  const r = screenReply({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
  assert.equal(r.blocked, true);
  assert.equal(r.speak, SAFE_LINE);
});

test('a blocked prompt is refused without echoing it back', () => {
  const r = screenReply({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(r.blocked, true);
  assert.equal(r.speak, SAFE_LINE);
  assert.ok(!r.speak.includes('SAFETY'));
});

// Silence reads as a broken toy at five, so there is always something to say.
test('an empty or malformed response still speaks a safe line', () => {
  for (const response of [{}, { candidates: [] }, ok('   ')]) {
    const r = screenReply(response);
    assert.equal(r.blocked, true);
    assert.equal(r.speak, SAFE_LINE);
    assert.ok(r.speak.length > 0);
  }
});

test('a truncated reply is still spoken rather than discarded', () => {
  const r = screenReply({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'עננים הם' }] } }],
  });
  assert.equal(r.blocked, false);
});

// Only allowlisted ids may cross into storage, whatever the model claims.
test('a topic outside the allowlist is dropped', () => {
  const call = { parts: [{ functionCall: { name: 'note_topic', args: { topic: 'שם של ילד' } } }] };
  assert.equal(screenReply(ok('טקסט', call)).topic, '');
});

test('an allowlisted topic is kept', () => {
  const call = { parts: [{ functionCall: { name: 'note_topic', args: { topic: 'weather' } } }] };
  assert.equal(screenReply(ok('טקסט', call)).topic, 'weather');
});

test('the topic enum matches the curiosity-map allowlist exactly', () => {
  assert.deepEqual([...TOPIC_ENUM].sort(), [...TOPIC_IDS].sort());
});

test('a blocked reply cannot smuggle a topic through', () => {
  const r = screenReply({ promptFeedback: { blockReason: 'SAFETY' } });
  assert.equal(r.topic, '');
});

test('markup and emoji are stripped because everything is read aloud', () => {
  assert.equal(stripForSpeech('**היי** 🎉 _שלום_'), 'היי שלום');
  assert.equal(stripForSpeech('ראה [כאן](http://x)'), 'ראה כאן');
});

test('the prompt carries the child and the week, in the right grammatical form', () => {
  const p = systemPrompt(CHILD, ADVENTURE);
  assert.ok(p.includes('מצרים העתיקה'));
  assert.ok(p.includes('בנה פירמידה קטנה מקוביות.'));
  assert.ok(p.includes('לשון זכר'));
  assert.ok(systemPrompt({ ...CHILD, form: 'feminine' }, ADVENTURE).includes('לשון נקבה'));
});

// Audio context is what made a speech-to-speech model cost more than
// ElevenLabs past ~37 turns; history must stay text.
test('only the current turn is audio; history stays text', () => {
  const body = turnRequest({
    system: 'S',
    history: [{ role: 'agent', text: 'שלום' }, { role: 'child', text: 'היי' }],
    audio: 'BASE64',
  });
  const audioParts = body.contents.filter((c) => c.parts.some((p) => p.inlineData));
  assert.equal(audioParts.length, 1);
  assert.equal(body.contents.at(-1).role, 'user');
  assert.equal(body.contents[0].role, 'model');
  assert.equal(body.contents[1].role, 'user');
});

test('every turn carries the safety settings and the topic tool', () => {
  const body = turnRequest({ system: 'S', history: [], audio: 'B' });
  assert.deepEqual(body.safetySettings, SAFETY_SETTINGS);
  assert.equal(body.tools[0].functionDeclarations[0].name, 'note_topic');
  assert.ok(SAFETY_SETTINGS.every((s) => s.threshold === 'BLOCK_LOW_AND_ABOVE'));
});

test('history is capped so a long session cannot grow without bound', () => {
  let history = [];
  for (let i = 0; i < 40; i++) history = appendTurn(history, 'child', `t${i}`, 20);
  assert.equal(history.length, 20);
  assert.equal(history.at(-1).text, 't39');
});

// The TTS model answers a bare question instead of reading it, and Chiki's
// lines are mostly questions.
test('speech requests instruct the model to read, not answer', () => {
  const body = speechRequest('למה יש עננים?');
  assert.ok(body.contents[0].parts[0].text.startsWith('Read the following aloud'));
  assert.ok(body.contents[0].parts[0].text.includes('למה יש עננים?'));
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
});
