-- up
-- First-login-only tracking — one row per user, ever. Mirrors eaze-checkin's
-- own login_logs table (same first_login_date/first_login_time-as-separate-
-- IST-columns shape, same one-row-per-user invariant), adapted to this app's
-- identity model: user_id here is the real Eaze platform user id, tracked
-- separately from phone_number.
CREATE TABLE login_logs_choices (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  first_login_date DATE NOT NULL,
  first_login_time TIME NOT NULL,
  CONSTRAINT login_logs_choices_user_id_key UNIQUE (user_id)
);

CREATE INDEX login_logs_choices_phone_number_index ON login_logs_choices (phone_number);

-- down
DROP TABLE login_logs_choices;
