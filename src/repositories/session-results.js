// App-specific data access, built on top of the generic client in ../db/client.js.
// No leaderboard reads here by design — this is write-only result capture.
import { dbEnabled, withTransaction } from '../db/client.js';

export async function recordSessionResult({
  clientId, displayName, topicId, sessionNumber,
  correctCount, totalCount, bestStreak, durationMs,
}) {
  if (!dbEnabled) return { persisted: false };

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO players (client_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (client_id)
       DO UPDATE SET display_name = COALESCE($2, players.display_name), updated_at = NOW()
       RETURNING id`,
      [clientId, displayName || null],
    );
    const playerId = rows[0].id;

    await client.query(
      `INSERT INTO session_results
         (player_id, topic_id, session_number, correct_count, total_count, best_streak, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playerId, topicId, sessionNumber, correctCount, totalCount, bestStreak || 0, durationMs ?? null],
    );

    return { persisted: true };
  });
}
