// Per-card result tracking for the new content model: 20 sessions x 15
// cards, no topics, one global session per day, 2 EazeScore per card
// engaged with (answered, right or wrong — see recordCardResult).
// There's no separate "sessions" table — a completed session is derived as
// >=15 distinct card_number rows for the same eaze_user_id + IST day.
import { dbEnabled, query, withTransaction } from '../db/client.js';
import { insertScoreEvent, CARD_COMPLETE_EVENT_TYPE } from './score-events.js';
import { recordSessionCompletion } from './session-logs.js';
import { recordSessionEngagement } from './session-count.js';

export const CARDS_PER_SESSION = 15;
export const TOTAL_SESSIONS = 20;
const CARD_POINTS = 2;

export function getISTDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function addDaysToDateString(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function msUntilNextISTMidnight() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const secondsSinceMidnight = get('hour') * 3600 + get('minute') * 60 + get('second');
  return (24 * 3600 - secondsSinceMidnight) * 1000;
}

// One row per card answered. ON CONFLICT targets
// card_results_one_per_card_per_day (see the matching migration) — a card
// already answered today earns nothing further, but the same card can be
// answered again (and re-scored) on a later day if that day's session was
// never completed the first time around.
export async function recordCardResult({ eazeUserId, sessionNumber, cardNumber, isCorrect, userId }) {
  if (!dbEnabled) return { persisted: false };

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO card_results (eaze_user_id, session_number, card_number, is_correct)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (eaze_user_id, session_number, card_number, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
       DO NOTHING
       RETURNING id`,
      [eazeUserId, sessionNumber, cardNumber, isCorrect],
    );

    if (rows.length === 0) {
      return { persisted: true, scoreEvent: null, duplicate: true };
    }

    const scoreEvent = await insertScoreEvent(client, {
      eazeUserId,
      sourceApp: 'level-up',
      eventType: CARD_COMPLETE_EVENT_TYPE,
      points: CARD_POINTS,
      metadata: { sessionNumber, cardNumber },
    });

    // Whether THIS card is the one that just started or just completed
    // today's session — both checked in the same transaction as the insert
    // above, so a concurrent duplicate request can never double-count either
    // edge.
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM card_results
       WHERE eaze_user_id = $1 AND session_number = $2
         AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [eazeUserId, sessionNumber],
    );
    const justStartedSession = countRows[0].count === 1;
    const justCompletedSession = countRows[0].count === CARDS_PER_SESSION;

    return { persisted: true, scoreEvent, justStartedSession, justCompletedSession };
  });

  // session_count and session_logs_choices only ever record banner-entered
  // (real userId) users — never fabricated for the typed-phone dev login
  // path — and only fire on the exact card that started/completed the
  // session, not every card.
  if (result.justStartedSession && userId) {
    await recordSessionEngagement({ userId, phoneNumber: eazeUserId, sessionNumber });
  }
  if (result.justCompletedSession && userId) {
    const sessionsCount = await getCompletedSessionsCount(eazeUserId);
    await recordSessionCompletion({ userId, phoneNumber: eazeUserId, sessionsCount });
  }

  return result;
}

// Calendar days (IST, as 'YYYY-MM-DD' strings straight from Postgres — no
// JS-side timezone math) where the user answered at least `minCards` cards.
async function getCompletedDayStrings(eazeUserId, minCards) {
  const { rows } = await query(
    `SELECT TO_CHAR((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day
     FROM card_results
     WHERE eaze_user_id = $1
     GROUP BY day
     HAVING COUNT(*) >= $2
     ORDER BY day`,
    [eazeUserId, minCards],
  );
  return rows.map((r) => r.day);
}

// Days the user touched at least one card, complete or not — used only for
// session-number rotation (see getTodaySessionState): a day left completely
// untouched (no rows at all — a user who never opened that day's session)
// must not advance the rotation, so the same session is offered again next
// time, but a day with even one card answered has "used up" that slot and
// rotation should move on, same as a full completion would. Completion-based
// stats (getCompletedSessionsCount, getStreak) stay on the >=CARDS_PER_SESSION
// threshold — this is a distinct, looser notion of "a day counted."
async function getEngagedDayStrings(eazeUserId) {
  return getCompletedDayStrings(eazeUserId, 1);
}

function computeStreak(completedDaySet, asOf) {
  let streak = 0;
  let cursor = asOf;
  while (completedDaySet.has(cursor)) {
    streak++;
    cursor = addDaysToDateString(cursor, -1);
  }
  return streak;
}

export async function getCompletedSessionsCount(eazeUserId) {
  if (!dbEnabled) return 0;
  const days = await getCompletedDayStrings(eazeUserId, CARDS_PER_SESSION);
  return days.length;
}

// Consecutive IST days (ending today, or yesterday if today isn't finished
// yet so a streak doesn't visibly read as broken before midnight actually
// passes — same grace rule eaze-checkin uses) with a fully completed
// session. Lives on the lifetime EazeScore page, not the gameplay-entry
// check below.
export async function getStreak(eazeUserId) {
  if (!dbEnabled) return 0;
  const completedDaySet = new Set(await getCompletedDayStrings(eazeUserId, CARDS_PER_SESSION));
  const today = getISTDateString();
  const streak = computeStreak(completedDaySet, today);
  if (streak > 0) return streak;
  return computeStreak(completedDaySet, addDaysToDateString(today, -1));
}

// The single source of truth for "what should this user see right now when
// they try to play": which session number is next, which of its cards are
// already answered today (so the frontend can skip straight past them on
// resume), and whether today's session is already fully done (locked, per
// §7's darkened button).
export async function getTodaySessionState(eazeUserId, {
  totalSessions = TOTAL_SESSIONS, cardsPerSession = CARDS_PER_SESSION,
} = {}) {
  if (!dbEnabled) return { persisted: false };

  // Today itself must be excluded when deriving the session number — if it
  // weren't, finishing today's session would immediately advance the count
  // and hand back tomorrow's (unlocked) session number in the very same
  // response, defeating "one session per day" the instant it's satisfied.
  //
  // Rotation is driven by ENGAGED days, not just completed ones: a session
  // left entirely untouched keeps showing up as-is (no rows exist for that
  // day, so it never enters this set), but a session merely started and
  // abandoned (1-14 cards) still counts as that day's slot used, so the next
  // day rotates forward to the next session rather than re-offering the
  // abandoned one.
  const engagedDays = await getEngagedDayStrings(eazeUserId);
  const today = getISTDateString();
  const engagedDaysBeforeToday = engagedDays.filter((d) => d !== today);
  const sessionNumber = (engagedDaysBeforeToday.length % totalSessions) + 1;

  const { rows: todayRows } = await query(
    `SELECT card_number, is_correct FROM card_results
     WHERE eaze_user_id = $1 AND session_number = $2
       AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     ORDER BY card_number`,
    [eazeUserId, sessionNumber],
  );
  const cardsCompletedToday = todayRows.map((r) => ({ cardNumber: r.card_number, isCorrect: r.is_correct }));
  const locked = cardsCompletedToday.length >= cardsPerSession;

  return {
    persisted: true,
    sessionNumber,
    cardsPerSession,
    cardsCompletedToday,
    locked,
    msUntilMidnightIST: locked ? msUntilNextISTMidnight() : null,
  };
}
