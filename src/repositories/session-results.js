// App-specific data access, built on top of the generic client in ../db/client.js.
// No leaderboard reads here by design — this is write-only result capture.
import { dbEnabled, withTransaction } from '../db/client.js';
import { insertScoreEvent } from './score-events.js';

const SESSION_POINTS = 5;
const ALL_TOPICS_BONUS_POINTS = 15; // 5 base + 10 bonus, awarded as one event
const ALL_TOPICS_BONUS_EVENT_TYPE = 'session_complete_all_topics_bonus';
const SESSION_EVENT_TYPE = 'session_complete';

export async function recordSessionResult({
  clientId, displayName, eazeUserId, topicId, sessionNumber,
  correctCount, totalCount, bestStreak, durationMs, totalTopicCount,
}) {
  if (!dbEnabled) return { persisted: false };

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO players (client_id, display_name, eaze_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id)
       DO UPDATE SET display_name = COALESCE($2, players.display_name),
                     eaze_user_id = COALESCE($3, players.eaze_user_id),
                     updated_at = NOW()
       RETURNING id`,
      [clientId, displayName || null, eazeUserId || null],
    );
    const playerId = rows[0].id;

    await client.query(
      `INSERT INTO session_results
         (player_id, topic_id, session_number, correct_count, total_count, best_streak, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playerId, topicId, sessionNumber, correctCount, totalCount, bestStreak || 0, durationMs ?? null],
    );

    // No eazeUserId → nothing to credit yet (this app has no other durable
    // identity to hang a cross-app score event on). The session result above
    // still gets recorded either way.
    if (!eazeUserId) {
      return { persisted: true, scoreEvent: null };
    }

    // Same-day (IST), all-topics bonus check runs against this app's own
    // session_results — the source of truth for "did this player touch every
    // topic today," not client-supplied state. Gated by a same-day lookup
    // against score_events too, so a duplicate/retried submission of the
    // topic-completing session can never award the bonus twice: the first
    // insert wins, every later one just sees the bonus event already there
    // and falls back to the plain per-session points.
    let eventType = SESSION_EVENT_TYPE;
    let points = SESSION_POINTS;

    if (totalTopicCount > 0) {
      const [{ rows: topicRows }, { rows: bonusRows }] = await Promise.all([
        client.query(
          `SELECT COUNT(DISTINCT topic_id)::int AS cnt
           FROM session_results
           WHERE player_id = $1
             AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
          [playerId],
        ),
        client.query(
          `SELECT EXISTS(
             SELECT 1 FROM score_events
             WHERE eaze_user_id = $1
               AND event_type = $2
               AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
           ) AS awarded`,
          [eazeUserId, ALL_TOPICS_BONUS_EVENT_TYPE],
        ),
      ]);

      const distinctTopicsToday = topicRows[0].cnt;
      const bonusAlreadyAwardedToday = bonusRows[0].awarded;

      if (distinctTopicsToday >= totalTopicCount && !bonusAlreadyAwardedToday) {
        eventType = ALL_TOPICS_BONUS_EVENT_TYPE;
        points = ALL_TOPICS_BONUS_POINTS;
      }
    }

    const scoreEvent = await insertScoreEvent(client, {
      eazeUserId,
      sourceApp: 'level-up',
      eventType,
      points,
      metadata: { topicId, sessionNumber },
    });

    return { persisted: true, scoreEvent };
  });
}
