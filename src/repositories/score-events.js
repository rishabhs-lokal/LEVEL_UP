// Data access for the shared, append-only EazeScore ledger. Every app that
// reports activity into EazeScore (this one, eaze-checkin, and whatever
// comes later) writes rows here — total score is always derived by summing
// them, never stored as a mutable counter.
import { dbEnabled, query, withTransaction } from '../db/client.js';

export const SOURCE_APPS = ['checkin', 'level-up'];

// Single source of truth for these two event_type strings — session-results.js
// imports them rather than redefining its own, so the "count of sessions
// played" query below can never silently drift out of sync with what
// actually gets written on session completion.
export const SESSION_EVENT_TYPE = 'session_complete';
export const ALL_TOPICS_BONUS_EVENT_TYPE = 'session_complete_all_topics_bonus';
const SESSION_EVENT_TYPES = [SESSION_EVENT_TYPE, ALL_TOPICS_BONUS_EVENT_TYPE];

const WELCOME_BONUS_EVENT_TYPE = 'welcome_bonus';
const WELCOME_BONUS_POINTS = 20;

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
// counter — the whole point of an append-only event table. sessionCount
// counts this app's own session-completion events specifically (not
// eaze-checkin's check-ins) — each one corresponds 1:1 with a completed
// eaze-level-up session, so it's an exact count, not an estimate.
export async function getScoreForUser(eazeUserId) {
  if (!dbEnabled) return { persisted: false };

  const [{ rows: sumRows }, { rows: sessionRows }, { rows: eventRows }] = await Promise.all([
    query('SELECT COALESCE(SUM(points), 0)::int AS total FROM score_events WHERE eaze_user_id = $1', [eazeUserId]),
    query(
      'SELECT COUNT(*)::int AS cnt FROM score_events WHERE eaze_user_id = $1 AND event_type = ANY($2)',
      [eazeUserId, SESSION_EVENT_TYPES],
    ),
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
    sessionCount: sessionRows[0].cnt,
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
