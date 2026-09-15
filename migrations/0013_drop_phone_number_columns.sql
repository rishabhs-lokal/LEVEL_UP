-- up
-- Phone numbers are no longer collected anywhere in this app — banner entry
-- now hands over only user_id, and every logging table drops its
-- phone_number column accordingly. Existing phone data is discarded.
DROP INDEX IF EXISTS login_logs_choices_phone_number_index;
ALTER TABLE login_logs_choices DROP COLUMN phone_number;

DROP INDEX IF EXISTS session_logs_choices_phone_number_index;
ALTER TABLE session_logs_choices DROP COLUMN phone_number;

DROP INDEX IF EXISTS open_session_logs_phone_number_index;
ALTER TABLE open_session_logs DROP COLUMN phone_number;

DROP INDEX IF EXISTS claim_choices_phone_number_index;
ALTER TABLE claim_choices DROP COLUMN phone_number;

DROP INDEX IF EXISTS session_count_phone_number_index;
ALTER TABLE session_count DROP COLUMN phone_number;

-- down
-- Re-added as nullable — the original phone data is gone, so it can't be
-- restored as NOT NULL without fabricating values.
ALTER TABLE login_logs_choices ADD COLUMN phone_number TEXT;
CREATE INDEX login_logs_choices_phone_number_index ON login_logs_choices (phone_number);

ALTER TABLE session_logs_choices ADD COLUMN phone_number TEXT;
CREATE INDEX session_logs_choices_phone_number_index ON session_logs_choices (phone_number);

ALTER TABLE open_session_logs ADD COLUMN phone_number TEXT;
CREATE INDEX open_session_logs_phone_number_index ON open_session_logs (phone_number);

ALTER TABLE claim_choices ADD COLUMN phone_number TEXT;
CREATE INDEX claim_choices_phone_number_index ON claim_choices (phone_number);

ALTER TABLE session_count ADD COLUMN phone_number TEXT;
CREATE INDEX session_count_phone_number_index ON session_count (phone_number);
