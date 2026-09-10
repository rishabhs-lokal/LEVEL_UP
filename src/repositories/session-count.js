// Append-only log (session_count) — one row per session a user engages
// with, fired on the first card answered for that session_number/day. Same
// conventions as the other choices-app log tables: user_id is the real Eaze
// platform user id, only recorded when the caller actually has one
// (banner-entered users), never fabricated for the typed-phone dev login
// path.
import { dbEnabled, query } from '../db/client.js';
import { istNowParts } from '../lib/ist-time.js';

export async function recordSessionEngagement({ userId, phoneNumber, sessionNumber }) {
  if (!dbEnabled) return { persisted: false };
  const { date, time } = istNowParts();
  const { rows } = await query(
    `INSERT INTO session_count (user_id, phone_number, session_number, log_date, log_time)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, phone_number, session_number, log_date, log_time`,
    [userId, phoneNumber, sessionNumber, date, time],
  );
  return { persisted: true, log: rows[0] };
}
