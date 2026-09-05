import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';

// Node has no Workers binding. Stub only the runtime base class, not HTTP logic.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return {
      url: 'data:text/javascript,export class DurableObject { constructor(ctx) { this.ctx = ctx; } }',
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
crypto.subtle.timingSafeEqual = timingSafeEqual;
const { default: worker, SessionCounter } = await import('../src/index.js');

function environment() {
  const data = new Map();
  let alarm = null;
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    getAlarm: async () => alarm,
    setAlarm: async (at) => { alarm = at; },
  };
  const counter = new SessionCounter({ storage });
  return {
    DEVICE_TOKEN: 'test-only-token', ELEVENLABS_API_KEY: 'test-only-key',
    ELEVEN_AGENT_ID: 'test-agent', SESSION_DAILY_CAP: '2',
    COUNTER: { idFromName: (name) => name, get: () => counter },
    counter, storage,
  };
}

const request = (path, token = 'test-only-token') => new Request(`https://example.invalid${path}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test('HTTP health, auth, missing settings and daily cap fail closed with no-store errors', async (t) => {
  const env = environment();
  t.after(() => mock.restoreAll());
  const upstream = mock.method(globalThis, 'fetch', async () => Response.json({ signed_url: 'wss://example.invalid/session' }));
  assert.equal(await (await worker.fetch(request('/'), env)).text(), 'ok');
  for (const path of ['/session', '/progress']) {
    const response = await worker.fetch(request(path, 'wrong'), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await worker.fetch(request('/session'), { ...env, ELEVEN_AGENT_ID: '' })).status, 503);
  assert.equal((await worker.fetch(request('/session'), { ...env, SESSION_DAILY_CAP: '-1' })).status, 503);
  assert.equal(upstream.mock.callCount(), 0);
  const first = await worker.fetch(request('/session?progress=0'), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  const payload = await first.json();
  assert.deepEqual(Object.keys(payload).sort(), ['dynamic_variables', 'signed_url']);
  assert.equal(payload.dynamic_variables.progress_enabled, false);
  assert.equal(payload.dynamic_variables.last_topic, '');
  assert.equal((await worker.fetch(request('/session'), env)).status, 200);
  assert.equal((await worker.fetch(request('/session'), env)).status, 429);
  assert.equal(upstream.mock.callCount(), 2);
});

test('upstream response bodies and exceptions never enter public errors or server logs', async (t) => {
  t.after(() => mock.restoreAll());
  const logs = mock.method(console, 'log', () => {});
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('private upstream body', { status: 403 }));
  let response = await worker.fetch(request('/session'), environment());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream unavailable' });
  fetch.mock.mockImplementation(async () => { throw new Error('private exception detail'); });
  response = await worker.fetch(request('/session'), environment());
  assert.equal(response.status, 500);
  assert.ok(!JSON.stringify(logs.mock.calls).includes('private'));
});

test('an offered adventure is not claimed as an explored topic and an alarm expires detail', async () => {
  const env = environment();
  await env.storage.put('s', { lastTheme: 'space' });
  assert.equal((await env.counter.bump('2026-09-05', 2, Date.now())).latestTopic, '');
  await env.counter.recordProgress('test-conversation', Date.now(), ['space']);
  assert.ok(await env.storage.getAlarm());
  await env.storage.put('progress', {
    days: { '2020-01-01': ['space'] }, seen: { expired: 1 },
    lifetime_explorations: 1, lifetime_topics: ['space'],
  });
  await env.counter.alarm();
  const state = await env.storage.get('progress');
  assert.deepEqual(state.seen, {});
  assert.deepEqual(state.days, {});
  assert.equal(state.lifetime_explorations, 1);
});
