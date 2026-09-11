-- up
-- Append-only log — one row per successful coin claim (POST
-- /api/score/claim), capturing the EazeScore balance that was converted at
-- claim time. Same conventions as login_logs_choices / session_logs_choices
-- / open_session_logs: banner-entered users only (real user_id, never
-- fabricated for the typed-phone dev login path), IST date/time split into
-- two columns.
CREATE TABLE claim_choices (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  eazescore_claimed INTEGER NOT NULL,
  log_date DATE NOT NULL,
  log_time TIME NOT NULL
);

CREATE INDEX claim_choices_user_id_log_date_index ON claim_choices (user_id, log_date);
CREATE INDEX claim_choices_phone_number_index ON claim_choices (phone_number);

-- down
DROP TABLE claim_choices;
