// Append-only snapshot log (session_logs_choices) — one row per successfully
// completed session, capturing the user's lifetime sessions_count as of that
// completion. user_id is the real Eaze platform user id, distinct from
// phone_number (see login-logs.js) — only recorded when the caller actually
// has one (banner-entered users), never fabricated for the typed-phone dev
// login path.
import { dbEnabled, query } from '../db/client.js';
import { istNowParts } from '../lib/ist-time.js';

export async function recordSessionCompletion({ userId, phoneNumber, sessionsCount }) {
  if (!dbEnabled) return { persisted: false };
  const { date, time } = istNowParts();
  const { rows } = await query(
    `INSERT INTO session_logs_choices (user_id, phone_number, sessions_count, log_date, log_time)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, phone_number, sessions_count, log_date, log_time`,
    [userId, phoneNumber, sessionsCount, date, time],
  );
  return { persisted: true, log: rows[0] };
}
