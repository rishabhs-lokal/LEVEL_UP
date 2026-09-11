-- up
-- Partial unique index — at most one 'welcome_bonus' row per eaze_user_id.
-- Lets the award be a plain `INSERT ... ON CONFLICT (eaze_user_id) WHERE
-- event_type = 'welcome_bonus' DO NOTHING`, so "give the first-login bonus"
-- is safe to call on every login instead of needing separate check-then-
-- insert logic (and the race condition that pattern invites).
CREATE UNIQUE INDEX score_events_one_welcome_bonus_per_user
  ON score_events (eaze_user_id)
  WHERE event_type = 'welcome_bonus';

-- down
DROP INDEX IF EXISTS score_events_one_welcome_bonus_per_user;
