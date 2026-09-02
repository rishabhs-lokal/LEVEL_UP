// Data access for the shared, append-only EazeScore ledger. Every app that
// reports activity into EazeScore (this one, eaze-checkin, and whatever
// comes later) writes rows here — total score is always derived by summing
// them, never stored as a mutable counter.
import { dbEnabled, query, withTransaction } from '../db/client.js';

export const SOURCE_APPS = ['checkin', 'level-up'];

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
// counter — the whole point of an append-only event table.
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
