// Append-only log (claim_choices) — one row per successful coin claim,
// capturing the EazeScore balance that was converted at claim time. user_id
// is the real Eaze platform user id (see login-logs.js); only recorded when
// the caller actually has one (banner-entered users), never fabricated for
// the typed-phone dev login path.
import { dbEnabled, query } from '../db/client.js';
import { istNowParts } from '../lib/ist-time.js';

export async function recordClaim({ userId, phoneNumber, eazescoreClaimed }) {
  if (!dbEnabled) return { persisted: false };
  const { date, time } = istNowParts();
  const { rows } = await query(
    `INSERT INTO claim_choices (user_id, phone_number, eazescore_claimed, log_date, log_time)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, phone_number, eazescore_claimed, log_date, log_time`,
    [userId, phoneNumber, eazescoreClaimed, date, time],
  );
  return { persisted: true, log: rows[0] };
}
