-- up
-- Append-only log — one row per session CLOSE (finished or abandoned early),
-- not just successful completions (that's session_logs_choices). Captures
-- how far the user actually got: cards_engaged (touched, right or wrong) and
-- wrong_selections (the subset of those that were wrong), so abandonment can
-- be told apart from a clean finish.
CREATE TABLE open_session_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  cards_engaged INTEGER NOT NULL,
  wrong_selections INTEGER NOT NULL,
  log_date DATE NOT NULL,
  log_time TIME NOT NULL
);

CREATE INDEX open_session_logs_user_id_log_date_index ON open_session_logs (user_id, log_date);
CREATE INDEX open_session_logs_phone_number_index ON open_session_logs (phone_number);

-- down
DROP TABLE open_session_logs;
