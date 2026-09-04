import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADVENTURES, RESUME_MS, RETURN_SOON_MS, adventureFor, sessionTier, themeName,
} from '../src/adventure.mjs';

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const ALL_MISSIONS = new Set(ADVENTURES.flatMap(([, missions]) => missions));

test('tiers a session by how long ago the last one was', () => {
  assert.equal(sessionTier(NOW, 0), 'return_later');
  assert.equal(sessionTier(NOW, NOW - 1_000), 'resume');
  assert.equal(sessionTier(NOW, NOW - (RESUME_MS - 1)), 'resume');
  assert.equal(sessionTier(NOW, NOW - RESUME_MS), 'return_soon');
  assert.equal(sessionTier(NOW, NOW - (RETURN_SOON_MS - 1)), 'return_soon');
  assert.equal(sessionTier(NOW, NOW - RETURN_SOON_MS), 'return_later');
});

test('an accidental re-tap resumes instead of replaying the pitch', () => {
  const resumed = adventureFor(NOW, NOW - 1_000, 2, 'space');
  assert.ok(!resumed.opening_line.includes(resumed.weekly_theme));
  assert.ok(!resumed.opening_line.includes(resumed.today_mission));
  assert.ok(resumed.opening_line.length < 40);
});

test('repeat taps on the same day never reuse the mission', () => {
  const previousSeen = NOW - RESUME_MS;
  const missions = [0, 1, 2, 3, 4, 5, 6]
    .map((ordinal) => adventureFor(NOW, previousSeen, ordinal, '').today_mission);
  assert.equal(new Set(missions).size, 7);
  for (const mission of missions) assert.ok(ALL_MISSIONS.has(mission));
});

test('never offers the topic that was just explored as the alternative', () => {
  for (const topicId of ['space', 'jungle', 'oceans', 'weather', 'dinosaurs']) {
    const hebrew = themeName(topicId);
    for (let ordinal = 0; ordinal < 12; ordinal++) {
      const { opening_line: line } = adventureFor(NOW, NOW - RESUME_MS, ordinal, topicId);
      // Appears once as the "continue with X" half; twice would mean it was
      // also offered as the fresh alternative.
      assert.equal(line.split(hebrew).length - 1, 1, `${topicId} repeated at ${ordinal}`);
    }
  }
});

test('falls back to a plain invitation when the last topic has no theme name', () => {
  assert.equal(themeName('other'), '');
  assert.equal(themeName('nonsense'), '');
  const { opening_line: line, last_topic: lastTopic } =
    adventureFor(NOW, NOW - RESUME_MS, 1, 'other');
  assert.equal(lastTopic, '');
  assert.ok(!line.includes('להמשיך עם'));
});

test('a first-ever session introduces Chiki with the weekly theme', () => {
  const first = adventureFor(NOW, 0, 1, '');
  assert.ok(first.opening_line.includes('אני צ׳יקי'));
  assert.ok(first.opening_line.includes(first.weekly_theme));
  assert.ok(first.opening_line.includes(first.today_mission));
});
