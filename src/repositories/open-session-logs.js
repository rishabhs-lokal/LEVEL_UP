// Append-only log (open_session_logs) — one row per session close, whether
// finished or abandoned early. user_id is the real Eaze platform user id
// (see login-logs.js); only recorded when the caller actually has one
// (banner-entered users), never fabricated for the typed-phone dev login
// path.
import { dbEnabled, query } from '../db/client.js';
import { istNowParts } from '../lib/ist-time.js';

export async function recordOpenSessionClose({ userId, phoneNumber, cardsEngaged, wrongSelections }) {
  if (!dbEnabled) return { persisted: false };
  const { date, time } = istNowParts();
  const { rows } = await query(
    `INSERT INTO open_session_logs (user_id, phone_number, cards_engaged, wrong_selections, log_date, log_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, phone_number, cards_engaged, wrong_selections, log_date, log_time`,
    [userId, phoneNumber, cardsEngaged, wrongSelections, date, time],
  );
  return { persisted: true, log: rows[0] };
}
