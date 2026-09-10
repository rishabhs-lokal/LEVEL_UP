// Integration tests for the per-card content model: 20 sessions x 15 cards,
// no topics, one global session per day, 1 EazeScore per card. Hits a real
// Postgres (see score-events.test.js for why). Streak/session-cycling
// scenarios need multi-day fixtures, which recordCardResult can't produce
// on its own (it always stamps created_at as "now") — those tests insert
// backdated rows directly via query(), at IST noon on the target day so
// results never land on the wrong side of a day boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  recordCardResult, getTodaySessionState, getCompletedSessionsCount, getStreak, getISTDateString,
} from '../src/repositories/card-results.js';
import { getScoreForUser } from '../src/repositories/score-events.js';
import { query, closePool } from '../src/db/client.js';

function uniqueId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function istDateNDaysAgo(n) {
  const [y, m, d] = getISTDateString().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// Backdates a row to IST-noon on the given day so it's unambiguously inside
// that IST calendar date regardless of the host machine's own timezone.
async function insertBackdated(eazeUserId, { sessionNumber, cardNumber, isCorrect, daysAgo }) {
  await query(
    `INSERT INTO card_results (eaze_user_id, session_number, card_number, is_correct, created_at)
     VALUES ($1, $2, $3, $4, (($5::date + time '12:00:00') AT TIME ZONE 'Asia/Kolkata'))`,
    [eazeUserId, sessionNumber, cardNumber, isCorrect, istDateNDaysAgo(daysAgo)],
  );
}

async function completeFullDay(eazeUserId, { sessionNumber = 1, daysAgo, cardsPerSession = 15 }) {
  for (let card = 1; card <= cardsPerSession; card++) {
    await insertBackdated(eazeUserId, { sessionNumber, cardNumber: card, isCorrect: card % 2 === 0, daysAgo });
  }
}

// ── Per-card scoring ────────────────────────────────────────────────────

test('recordCardResult awards exactly 2 points per card', async () => {
  const eazeUserId = uniqueId('test-user');
  const result = await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 1, isCorrect: true });

  assert.equal(result.persisted, true);
  assert.equal(result.scoreEvent.points, 2);

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 2);
});

test('answering the same card twice the same day is deduped — no second point', async () => {
  const eazeUserId = uniqueId('test-user');

  const first = await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 3, isCorrect: false });
  assert.equal(first.scoreEvent.points, 2);

  const second = await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 3, isCorrect: true });
  assert.equal(second.duplicate, true);
  assert.equal(second.scoreEvent, null);

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 2, 'the repeat submission must not add any further points');
});

test('different cards in the same session each score independently', async () => {
  const eazeUserId = uniqueId('test-user');
  await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 1, isCorrect: true });
  await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 2, isCorrect: false });
  await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 3, isCorrect: true });

  const score = await getScoreForUser(eazeUserId);
  assert.equal(score.totalScore, 6);
});

// ── Today's session state: resume + lock ───────────────────────────────

test('a fresh user is offered session 1, unlocked, nothing completed today', async () => {
  const eazeUserId = uniqueId('test-user');
  const state = await getTodaySessionState(eazeUserId);

  assert.equal(state.sessionNumber, 1);
  assert.equal(state.locked, false);
  assert.deepEqual(state.cardsCompletedToday, []);
  assert.equal(state.msUntilMidnightIST, null);
});

test('completing all 15 cards today locks the session and reports each card\'s correctness', async () => {
  const eazeUserId = uniqueId('test-user');
  for (let card = 1; card <= 15; card++) {
    await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: card, isCorrect: card % 3 !== 0 });
  }

  const state = await getTodaySessionState(eazeUserId);
  assert.equal(state.locked, true);
  assert.equal(state.cardsCompletedToday.length, 15);
  assert.ok(state.msUntilMidnightIST > 0);
  // Spot-check the resume shape the frontend relies on to pre-mark dots.
  assert.deepEqual(state.cardsCompletedToday.find((c) => c.cardNumber === 3), { cardNumber: 3, isCorrect: false });
  assert.deepEqual(state.cardsCompletedToday.find((c) => c.cardNumber === 1), { cardNumber: 1, isCorrect: true });
});

test('a partially completed session today stays unlocked and lists only the answered cards', async () => {
  const eazeUserId = uniqueId('test-user');
  await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 1, isCorrect: true });
  await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: 2, isCorrect: true });

  const state = await getTodaySessionState(eazeUserId);
  assert.equal(state.locked, false);
  assert.equal(state.cardsCompletedToday.length, 2);
  assert.equal(state.msUntilMidnightIST, null);
});

// ── One session per day: cycling + retry-on-incomplete ─────────────────

test('the session number cycles with each fully completed prior day, wrapping modulo totalSessions', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 3 });
  await completeFullDay(eazeUserId, { daysAgo: 2 });
  await completeFullDay(eazeUserId, { daysAgo: 1 });

  // 3 completed prior days, small totalSessions so the wrap is exercised
  // without needing 20 real days of fixtures.
  const state = await getTodaySessionState(eazeUserId, { totalSessions: 3, cardsPerSession: 15 });
  assert.equal(state.sessionNumber, 1, '3 completed days % 3 total sessions wraps back to session 1');
});

test('a partially completed prior day still advances the session cycle — it is not retried', async () => {
  const eazeUserId = uniqueId('test-user');
  // Only 10 of 15 cards yesterday — never "completed", but the user did
  // engage with it, so that slot is spent and today rotates to session 2
  // rather than re-offering the abandoned session 1.
  for (let card = 1; card <= 10; card++) {
    await insertBackdated(eazeUserId, { sessionNumber: 1, cardNumber: card, isCorrect: true, daysAgo: 1 });
  }

  const state = await getTodaySessionState(eazeUserId, { totalSessions: 20, cardsPerSession: 15 });
  assert.equal(state.sessionNumber, 2, 'a session abandoned mid-way must not be re-offered the next day');
});

test('a prior day with zero engagement is invisible to the cycle — the same session is offered again', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 2 });
  // daysAgo: 1 deliberately left completely untouched — no rows at all,
  // unlike the partial-engagement case above.

  const state = await getTodaySessionState(eazeUserId, { totalSessions: 20, cardsPerSession: 15 });
  assert.equal(state.sessionNumber, 2, 'the untouched day contributes nothing — rotation reflects only the one completed day');
});

test('finishing today\'s session does not itself unlock tomorrow\'s in the same response', async () => {
  const eazeUserId = uniqueId('test-user');
  for (let card = 1; card <= 15; card++) {
    await recordCardResult({ eazeUserId, sessionNumber: 1, cardNumber: card, isCorrect: true });
  }

  const state = await getTodaySessionState(eazeUserId, { totalSessions: 20, cardsPerSession: 15 });
  assert.equal(state.sessionNumber, 1, 'today must stay session 1 even though today is now fully complete');
  assert.equal(state.locked, true);
});

// ── Lifetime "sessions completed" ────────────────────────────────────────

test('getCompletedSessionsCount only counts days with the full card count', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 2 });
  // Partial day — must not count.
  for (let card = 1; card <= 5; card++) {
    await insertBackdated(eazeUserId, { sessionNumber: 1, cardNumber: card, isCorrect: true, daysAgo: 1 });
  }

  assert.equal(await getCompletedSessionsCount(eazeUserId), 1);
});

// ── Streak, with the "today isn't over yet" grace rule ──────────────────

test('a streak ending yesterday still counts today, when today has not been played at all', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 3 });
  await completeFullDay(eazeUserId, { daysAgo: 2 });
  await completeFullDay(eazeUserId, { daysAgo: 1 });

  assert.equal(await getStreak(eazeUserId), 3);
});

test('completing today extends the streak by one more', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 2 });
  await completeFullDay(eazeUserId, { daysAgo: 1 });
  await completeFullDay(eazeUserId, { daysAgo: 0 });

  assert.equal(await getStreak(eazeUserId), 3);
});

test('a gap in prior days breaks the streak even if today is not yet played', async () => {
  const eazeUserId = uniqueId('test-user');
  await completeFullDay(eazeUserId, { daysAgo: 3 });
  // daysAgo: 2 deliberately skipped — breaks continuity.
  await completeFullDay(eazeUserId, { daysAgo: 1 });

  assert.equal(await getStreak(eazeUserId), 1, 'only yesterday is contiguous with "today not yet played"');
});

test('a user who has never played has a zero streak', async () => {
  assert.equal(await getStreak(uniqueId('never-seen')), 0);
});

test.after(async () => {
  await closePool();
});
