import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';

test('real Workers runtime enforces auth and concurrent Durable Object limits', { timeout: 60_000 }, async () => {
  // An isolated root prevents Wrangler from reading any real .dev.vars or storage.
  const root = await mkdtemp(join(tmpdir(), 'chiki-runtime-test-'));
  await cp(new URL('../src/', import.meta.url), join(root, 'src'), { recursive: true });
  const server = createTestHarness({ root, workers: [{ config: {
    name: 'chiki-test', main: join(root, 'src/index.js'),
    compatibility_date: '2026-08-20', compatibility_flags: ['nodejs_compat'],
    vars: { DEVICE_TOKEN: 'test-only-token', ELEVEN_AGENT_ID: 'test-agent', ELEVENLABS_API_KEY: 'test-only-key' },
    durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'SessionCounter' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['SessionCounter'] }],
  } }] });
  try {
    await server.listen();
    assert.equal(await (await server.fetch('/')).text(), 'ok');
    assert.equal((await server.fetch('/session')).status, 401);
    assert.equal((await server.fetch('/progress')).status, 401);
    const progress = await server.fetch('/progress', { headers: { Authorization: 'Bearer test-only-token' } });
    assert.equal(progress.status, 200);
    assert.equal((await progress.json()).days.length, 84);
    const env = await server.getWorker().getEnv();
    const counter = env.COUNTER.get(env.COUNTER.idFromName('burst'));
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 40 }, () => counter.bump('2026-09-05', 5, now)));
    assert.equal(results.filter((result) => result.allowed).length, 5);
    assert.equal((await counter.recordProgress('test-conversation', now, ['space'])).changed, true);
    assert.equal((await counter.recordProgress('test-conversation', now, ['weather'])).duplicate, true);
    assert.equal((await counter.progress(now)).latest_topic, 'space');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
