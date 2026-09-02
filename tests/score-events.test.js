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
import { recordSessionResult } from '../src/repositories/session-results.js';
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
  await recordScoreEvent({ eazeUserId, sourceApp: 'level-up', eventType: 'session_complete', points: 5 });
  await recordScoreEvent({ eazeUserId, sourceApp: 'checkin', eventType: 'daily_checkin', points: 10 });
  await recordScoreEvent({ eazeUserId, sourceApp: 'level-up', eventType: 'session_complete', points: 5 });

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 20);
  assert.equal(score.events.length, 3);
});

test('GET for a user with no events returns a zero total, not an error', async () => {
  const score = await getScoreForUser(uniqueId('never-seen'));
  assert.equal(score.persisted, true);
  assert.equal(score.totalScore, 0);
  assert.deepEqual(score.events, []);
});

test('completing every topic the same day awards the all-topics bonus exactly once, even if the triggering session is resubmitted', async () => {
  const eazeUserId = uniqueId('test-user');
  const topics = ['stress', 'trauma', 'work', 'health', 'breakup-relationship', 'low-confidence'];

  for (const topicId of topics) {
    await recordSessionResult({
      eazeUserId, topicId, sessionNumber: 1,
      correctCount: 4, totalCount: 5, bestStreak: 2, durationMs: 20000,
      totalTopicCount: topics.length,
    });
  }

  // Simulate a network retry: the client resends the exact same request that
  // completed the 6th (bonus-triggering) topic. The one-per-topic-per-day
  // unique index means this earns nothing at all now, not even the plain
  // per-session points — a stronger guarantee than "no double bonus."
  const retryResult = await recordSessionResult({
    eazeUserId, topicId: 'low-confidence', sessionNumber: 1,
    correctCount: 4, totalCount: 5, bestStreak: 2, durationMs: 20000,
    totalTopicCount: topics.length,
  });
  assert.equal(retryResult.duplicate, true);
  assert.equal(retryResult.scoreEvent, null);

  const score = await getScoreForUser(eazeUserId);
  const bonusEvents = score.events.filter((e) => e.event_type === 'session_complete_all_topics_bonus');
  assert.equal(bonusEvents.length, 1, 'bonus must be awarded exactly once, not on the retried submission too');

  // 5 topics at 5 pts + 1 bonus-awarding session at 15 pts = 40. The
  // retried submission earns nothing further.
  assert.equal(score.totalScore, 40);
});

test('submitting the same topic twice in one day is rejected server-side, not just deduped for scoring', async () => {
  const eazeUserId = uniqueId('test-user');

  const first = await recordSessionResult({
    eazeUserId, topicId: 'stress', sessionNumber: 1,
    correctCount: 5, totalCount: 5, bestStreak: 5, durationMs: 10000,
    totalTopicCount: 6,
  });
  assert.equal(first.scoreEvent.points, 5);

  const second = await recordSessionResult({
    eazeUserId, topicId: 'stress', sessionNumber: 1,
    correctCount: 5, totalCount: 5, bestStreak: 5, durationMs: 10000,
    totalTopicCount: 6,
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.scoreEvent, null);

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 5, 'the repeat submission must not add any further points');
  assert.equal(score.sessionCount, 1);
});

test('recordSessionResult rejects a call with no eazeUserId — it is the only identity this app has', async () => {
  await assert.rejects(() => recordSessionResult({
    topicId: 'stress', sessionNumber: 1,
    correctCount: 3, totalCount: 5, bestStreak: 1, durationMs: 15000,
    totalTopicCount: 6,
  }));
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
