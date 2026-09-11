-- up
-- Append-only log — one row per session a user actually engages with,
-- firing on the first card answered for that session_number/day (mirrors
-- session_logs_choices, which fires on the last card instead). Multiple rows
-- can share the same session_number over time — sessions rotate 1..20 and
-- repeat as the user comes back day after day, so this is a play-log, not a
-- per-session-number unique record.
CREATE TABLE session_count (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  session_number INTEGER NOT NULL,
  log_date DATE NOT NULL,
  log_time TIME NOT NULL
);

CREATE INDEX session_count_user_id_log_date_index ON session_count (user_id, log_date);
CREATE INDEX session_count_phone_number_index ON session_count (phone_number);

-- down
DROP TABLE session_count;
