// Data access for the shared, append-only EazeScore ledger. Every app that
// reports activity into EazeScore (this one, eaze-checkin, and whatever
// comes later) writes rows here — total score is always derived by summing
// them, never stored as a mutable counter.
import { dbEnabled, query, withTransaction } from '../db/client.js';

export const SOURCE_APPS = ['checkin', 'level-up'];

// Single source of truth for this event_type string — card-results.js
// imports it rather than redefining its own.
export const CARD_COMPLETE_EVENT_TYPE = 'card_complete';

const WELCOME_BONUS_EVENT_TYPE = 'welcome_bonus';
const WELCOME_BONUS_POINTS = 20;
const CLAIM_EVENT_TYPE = 'claim';

// EazeScore -> coin conversion, tiered rather than 1:1: the first
// HALFWAY_THRESHOLD points of a claim convert at LOW_RATE, anything beyond
// that at HIGH_RATE. A claim always empties the full available balance (see
// claimScore below), never a partial amount. This app's HALFWAY_THRESHOLD is
// set independently of eaze-checkin's own backend/app/services/eaze_score.py
// compute_coins — the two apps share the score_events ledger itself, but not
// this rate; don't assume they need to match.
const COIN_HALFWAY_THRESHOLD = 150;
const COIN_LOW_RATE = 0.5;
const COIN_HIGH_RATE = 1.0;

// Rounds half up to a whole coin (e.g. an odd score at the 0.5 rate lands on
// an X.5 coin value, which rounds up, not down) — Math.floor(x + 0.5) rather
// than Math.round(), matching the Python reference's own reasoning exactly.
export function computeCoins(score) {
  if (score <= 0) return 0;
  const coins = score <= COIN_HALFWAY_THRESHOLD
    ? score * COIN_LOW_RATE
    : COIN_HALFWAY_THRESHOLD * COIN_LOW_RATE + (score - COIN_HALFWAY_THRESHOLD) * COIN_HIGH_RATE;
  return Math.floor(coins + 0.5);
}

// Inserts one row using a caller-supplied client — for callers already
// inside a transaction (e.g. this app's own session-complete flow, which
// needs the score event to land in the same transaction as the session
// result so the two can never go out of sync).
export async function insertScoreEvent(client, { eazeUserId, sourceApp, eventType, points, metadata }) {
  const { rows } = await client.query(
    `INSERT INTO score_events (eaze_user_id, source_app, event_type, points, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, eaze_user_id, source_app, event_type, points, metadata, created_at`,
    [eazeUserId, sourceApp, eventType, points, metadata ?? null],
  );
  return rows[0];
}

// Standalone entry point for callers with no transaction of their own — the
// POST /api/score/events route. Opens its own transaction for consistency
// with the rest of the write path, even though it's a single statement.
export async function recordScoreEvent(params) {
  if (!dbEnabled) return { persisted: false };
  const event = await withTransaction((client) => insertScoreEvent(client, params));
  return { persisted: true, event };
}

// Total is always derived by summing the ledger, never read from a stored
// counter — the whole point of an append-only event table. Lifetime
// "sessions completed" isn't derived here — that's a card_results concept
// now (see card-results.js's getCompletedSessionsCount), not something
// score_events itself can answer.
export async function getScoreForUser(eazeUserId) {
  if (!dbEnabled) return { persisted: false };

  const [{ rows: sumRows }, { rows: eventRows }] = await Promise.all([
    query('SELECT COALESCE(SUM(points), 0)::int AS total FROM score_events WHERE eaze_user_id = $1', [eazeUserId]),
    query(
      `SELECT id, source_app, event_type, points, metadata, created_at
       FROM score_events
       WHERE eaze_user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [eazeUserId],
    ),
  ]);

  return {
    persisted: true,
    eazeUserId,
    totalScore: sumRows[0].total,
    events: eventRows,
  };
}

// Idempotent — safe to call on every login. The partial unique index on
// (eaze_user_id) WHERE event_type = 'welcome_bonus' (see the matching
// migration) makes the insert a no-op after the first successful call, so
// there's no separate check-then-insert race to worry about.
export async function ensureWelcomeBonus(eazeUserId) {
  if (!dbEnabled) return { persisted: false, awarded: false };

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO score_events (eaze_user_id, source_app, event_type, points)
       VALUES ($1, 'level-up', $2, $3)
       ON CONFLICT (eaze_user_id) WHERE event_type = 'welcome_bonus' DO NOTHING
       RETURNING id, eaze_user_id, source_app, event_type, points, metadata, created_at`,
      [eazeUserId, WELCOME_BONUS_EVENT_TYPE, WELCOME_BONUS_POINTS],
    );
    return { persisted: true, awarded: rows.length > 0, event: rows[0] || null };
  });
}

// A claim always empties the user's full available balance, never a partial
// amount — same rule as eaze-checkin's own claim_coins. "Available" IS
// totalScore here: unlike the Python schema's separate earned/claimed sum,
// this ledger has no split to maintain — a claim is just another (negative)
// row in the same append-only sum, so the total already reflects it the
// instant it's inserted, from either app, since both read the same rows.
export async function claimScore(eazeUserId) {
  if (!dbEnabled) return { persisted: false };

  return withTransaction(async (client) => {
    const { rows: sumRows } = await client.query(
      'SELECT COALESCE(SUM(points), 0)::int AS total FROM score_events WHERE eaze_user_id = $1',
      [eazeUserId],
    );
    const available = sumRows[0].total;
    if (available <= 0) {
      return { persisted: true, claimed: false, available: 0, coins: 0 };
    }

    const coins = computeCoins(available);
    // Ledger deduction is inserted before the transfer is even attempted (see
    // the /api/score/claim route) — a failed transfer never undoes it, so a
    // concurrent second claim always sees this deduction already reflected.
    const event = await insertScoreEvent(client, {
      eazeUserId,
      sourceApp: 'level-up',
      eventType: CLAIM_EVENT_TYPE,
      points: -available,
      metadata: { coins },
    });

    return { persisted: true, claimed: true, available, coins, event };
  });
}
