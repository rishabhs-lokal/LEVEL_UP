-- up
-- Append-only snapshot log — one row per successfully completed session
-- (not a mutable counter), mirroring eaze-checkin's own cumulative-tracking
-- tables (eazescore_cumulative_logs, streak_log): each row captures the
-- user's lifetime sessions_count AS OF that completion, so the full history
-- of how it grew over time is preserved, not just the current total.
CREATE TABLE session_logs_choices (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  sessions_count INTEGER NOT NULL,
  log_date DATE NOT NULL,
  log_time TIME NOT NULL
);

CREATE INDEX session_logs_choices_user_id_log_date_index ON session_logs_choices (user_id, log_date);
CREATE INDEX session_logs_choices_phone_number_index ON session_logs_choices (phone_number);

-- down
DROP TABLE session_logs_choices;
