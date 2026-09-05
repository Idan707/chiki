import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SAFE_LINE, SAFETY_SETTINGS, TOPIC_ENUM, appendTurn, screenReply,
  capForSpeech, readTopic, speechRequest, splitForSpeech, stripForSpeech, systemPrompt,
  topicRequest, turnRequest,
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

test('the topic enum matches the curiosity-map allowlist exactly', () => {
  assert.deepEqual([...TOPIC_ENUM].sort(), [...TOPIC_IDS].sort());
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

test('every turn carries the safety settings', () => {
  const body = turnRequest({ system: 'S', history: [], audio: 'B' });
  assert.deepEqual(body.safetySettings, SAFETY_SETTINGS);
  assert.ok(SAFETY_SETTINGS.every((s) => s.threshold === 'BLOCK_LOW_AND_ABOVE'));
});

// A tool on the reply call made the model answer with a tool call and no text,
// so every reply fell through to the safe line.
test('the reply call carries no tools', () => {
  assert.equal(turnRequest({ system: 'S', history: [], audio: 'B' }).tools, undefined);
});

test('topic extraction can only return an allowlisted id', () => {
  const body = topicRequest([{ role: 'child', text: 'עננים' }]);
  assert.deepEqual(body.generationConfig.responseSchema.enum, [...TOPIC_ENUM, 'none']);
  assert.equal(readTopic({ candidates: [{ content: { parts: [{ text: 'weather' }] } }] }), 'weather');
  assert.equal(readTopic({ candidates: [{ content: { parts: [{ text: 'none' }] } }] }), '');
  assert.equal(readTopic({ candidates: [{ content: { parts: [{ text: 'שם של ילד' }] } }] }), '');
});

// Synthesis is the slowest stage and scales with length.
test('a long reply is split so the first sentence can be spoken sooner', () => {
  const long = 'עננים הם טיפות מים קטנטנות שעולות לשמיים. כשהן מתקררות הן נהיות כבדות ויורד גשם.';
  const parts = splitForSpeech(long);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith('.'));
  assert.equal(parts.join(' '), long);
});

// A model that ignored "two or three short sentences" once returned 988
// characters: 23 seconds of synthesis a five-year-old will not wait through.
test('an over-long reply is capped at a sentence end', () => {
  const long = ('עננים הם טיפות מים קטנטנות שעולות לשמיים. ').repeat(12);
  const capped = capForSpeech(long);
  assert.ok(capped.length <= 220);
  assert.ok(capped.endsWith('.'));
});

test('a reply within the cap is untouched', () => {
  assert.equal(capForSpeech('עננים הם טיפות מים.'), 'עננים הם טיפות מים.');
});

test('screening applies the cap', () => {
  const long = ('עננים הם טיפות מים קטנטנות שעולות לשמיים. ').repeat(12);
  assert.ok(screenReply(ok(long)).speak.length <= 220);
});

test('a short reply is not split', () => {
  assert.deepEqual(splitForSpeech('אני כאן. על מה נמשיך?'), ['אני כאן. על מה נמשיך?']);
});

// Thinking cannot be turned off on this model and is charged against the same
// budget: at 300 tokens it spent 286 reasoning and the reply came back empty.
test('the reply budget clears the thinking it cannot disable', () => {
  const g = turnRequest({ system: 'S', history: [], audio: 'B' }).generationConfig;
  assert.equal(g.thinkingConfig.thinkingLevel, 'low');
  assert.ok(g.maxOutputTokens >= 1000, 'must clear ~550 thought tokens plus the reply');
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
