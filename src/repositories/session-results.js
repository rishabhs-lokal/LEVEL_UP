// App-specific data access, built on top of the generic client in ../db/client.js.
// No leaderboard reads here by design — this is write-only result capture.
// Keyed entirely on eaze_user_id — the only identity this app has, since
// login is mandatory before a session can ever complete.
import { dbEnabled, withTransaction } from '../db/client.js';
import { insertScoreEvent, SESSION_EVENT_TYPE, ALL_TOPICS_BONUS_EVENT_TYPE } from './score-events.js';

const SESSION_POINTS = 5;
const ALL_TOPICS_BONUS_POINTS = 15; // 5 base + 10 bonus, awarded as one event

export async function recordSessionResult({
  eazeUserId, topicId, sessionNumber,
  correctCount, totalCount, bestStreak, durationMs, totalTopicCount,
}) {
  if (!dbEnabled) return { persisted: false };

  return withTransaction(async (client) => {
    // ON CONFLICT targets session_results_one_per_topic_per_day (see the
    // matching migration) — one play per topic per eaze_user_id per IST
    // day, for real, at the database level. A second submission for a
    // topic already completed today (retry, replay, or a different
    // device/browser under the same eazeUserId) inserts nothing and earns
    // nothing further.
    const { rows: sessionRows } = await client.query(
      `INSERT INTO session_results
         (eaze_user_id, topic_id, session_number, correct_count, total_count, best_streak, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (eaze_user_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date)) DO NOTHING
       RETURNING id`,
      [eazeUserId, topicId, sessionNumber, correctCount, totalCount, bestStreak || 0, durationMs ?? null],
    );

    if (sessionRows.length === 0) {
      return { persisted: true, scoreEvent: null, duplicate: true };
    }

    // Same-day (IST) all-topics bonus check runs against this app's own
    // session_results — the source of truth for "did this player touch
    // every topic today," not client-supplied state. Gated by a same-day
    // lookup against score_events too, so a duplicate/retried submission of
    // the topic-completing session can never award the bonus twice.
    let eventType = SESSION_EVENT_TYPE;
    let points = SESSION_POINTS;

    if (totalTopicCount > 0) {
      const [{ rows: topicRows }, { rows: bonusRows }] = await Promise.all([
        client.query(
          `SELECT COUNT(DISTINCT topic_id)::int AS cnt
           FROM session_results
           WHERE eaze_user_id = $1
             AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
          [eazeUserId],
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
