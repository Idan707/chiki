import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adventureFor } from '../src/adventure.mjs';
import { TOPIC_IDS } from '../src/progress.mjs';

test('every curated opening fits the firmware UTF-8 session and initiation buffers', () => {
  const header = readFileSync(new URL('../../firmware/main/net.h', import.meta.url), 'utf8');
  const cap = (name) => Number(header.match(new RegExp(`#define ${name} (\\d+)`))[1]);
  const url = 'wss://' + 'x'.repeat(cap('NET_SIGNED_URL_CAP') - 7);
  const now = Date.UTC(2026, 8, 5);
  for (let day = 0; day < 70; day++) {
    const at = now + day * 86_400_000;
    for (const previous of [0, at - 1000, at - 3_600_000, at - 86_400_000]) {
      for (const topic of ['', ...TOPIC_IDS]) {
        const variables = { ...adventureFor(at, previous, day % 20, topic), progress_enabled: true };
        assert.ok(Buffer.byteLength(JSON.stringify(variables)) < cap('NET_DYNAMIC_VARIABLES_CAP'));
        assert.ok(Buffer.byteLength(JSON.stringify({ signed_url: url, dynamic_variables: variables }))
          < cap('NET_SESSION_BODY_CAP') - 1);
      }
    }
  }
});
