// Integration tests for the shared EazeScore ledger. These hit a real
// Postgres (DATABASE_URL must be set — see package.json's "test" script),
// not a mock, since the whole point of this ledger is correct SQL-level
// behavior (SUM, same-day windowing, transactional atomicity). Every test
// uses its own randomly-generated eazeUserId/clientId so runs never collide
// with each other or with real data, and there's nothing to clean up after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordScoreEvent, getScoreForUser } from '../src/repositories/score-events.js';
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
  const clientId = uniqueId('test-client');
  const topics = ['stress', 'trauma', 'work', 'health', 'breakup-relationship', 'low-confidence'];

  for (const topicId of topics) {
    await recordSessionResult({
      clientId, eazeUserId, topicId, sessionNumber: 1,
      correctCount: 4, totalCount: 5, bestStreak: 2, durationMs: 20000,
      totalTopicCount: topics.length,
    });
  }

  // Simulate a network retry: the client resends the exact same request that
  // completed the 6th (bonus-triggering) topic.
  await recordSessionResult({
    clientId, eazeUserId, topicId: 'low-confidence', sessionNumber: 1,
    correctCount: 4, totalCount: 5, bestStreak: 2, durationMs: 20000,
    totalTopicCount: topics.length,
  });

  const score = await getScoreForUser(eazeUserId);
  const bonusEvents = score.events.filter((e) => e.event_type === 'session_complete_all_topics_bonus');
  assert.equal(bonusEvents.length, 1, 'bonus must be awarded exactly once, not on the retried submission too');

  // 5 topics at 5 pts + 1 bonus-awarding session at 15 pts + 1 retried
  // (post-bonus) session at the plain 5 pts = 45.
  assert.equal(score.totalScore, 45);
});

test('recordSessionResult without an eazeUserId still records the session, but no score event', async () => {
  const clientId = uniqueId('test-client-anon');
  const result = await recordSessionResult({
    clientId, topicId: 'stress', sessionNumber: 1,
    correctCount: 3, totalCount: 5, bestStreak: 1, durationMs: 15000,
    totalTopicCount: 6,
  });

  assert.equal(result.persisted, true);
  assert.equal(result.scoreEvent, null);
});

test.after(async () => {
  await closePool();
});
