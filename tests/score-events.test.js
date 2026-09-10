// Integration tests for the shared EazeScore ledger. These hit a real
// Postgres (DATABASE_URL must be set — see package.json's "test" script),
// not a mock, since the whole point of this ledger is correct SQL-level
// behavior (SUM, same-day windowing, transactional atomicity). Every test
// uses its own randomly-generated eazeUserId so runs never collide
// with each other or with real data, and there's nothing to clean up after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordScoreEvent, getScoreForUser, ensureWelcomeBonus } from '../src/repositories/score-events.js';
import { closePool } from '../src/db/client.js';

function uniqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

test('posting a score event creates exactly one row', async () => {
  const eazeUserId = uniqueId('test-user');
  const result = await recordScoreEvent({
    eazeUserId, sourceApp: 'checkin', eventType: 'daily_checkin', points: 10, metadata: null,
  });

  assert.equal(result.persisted, true);
  assert.equal(result.event.eaze_user_id, eazeUserId);
  assert.equal(result.event.points, 10);

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.events.length, 1, 'exactly one row should exist for this user');
});

test('GET returns the correct sum across multiple events and apps', async () => {
  const eazeUserId = uniqueId('test-user');
  await recordScoreEvent({ eazeUserId, sourceApp: 'level-up', eventType: 'card_complete', points: 1 });
  await recordScoreEvent({ eazeUserId, sourceApp: 'checkin', eventType: 'daily_checkin', points: 10 });
  await recordScoreEvent({ eazeUserId, sourceApp: 'level-up', eventType: 'card_complete', points: 1 });

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 12);
  assert.equal(score.events.length, 3);
});

test('GET for a user with no events returns a zero total, not an error', async () => {
  const score = await getScoreForUser(uniqueId('never-seen'));
  assert.equal(score.persisted, true);
  assert.equal(score.totalScore, 0);
  assert.deepEqual(score.events, []);
});

test('ensureWelcomeBonus awards 20 points once, and is a no-op on every later call', async () => {
  const eazeUserId = uniqueId('test-user');

  const first = await ensureWelcomeBonus(eazeUserId);
  assert.equal(first.awarded, true);
  assert.equal(first.event.points, 20);

  const second = await ensureWelcomeBonus(eazeUserId);
  assert.equal(second.awarded, false);
  assert.equal(second.event, null);

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 20, 'bonus must be counted exactly once no matter how many times login fires it');
});

test.after(async () => {
  await closePool();
});
