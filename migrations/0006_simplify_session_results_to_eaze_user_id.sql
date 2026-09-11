-- up
-- Simplifies the identity model: eaze_user_id is the only identity this app
-- actually needs. Login is mandatory before a session can ever complete, so
-- it's always available by the time session_results gets written to —
-- client_id/player_id/the players table were built earlier, before
-- eaze_user_id existed, as an anonymous per-device fallback. They'd become
-- pure redundant indirection once login became mandatory, and were the
-- actual source of two real bugs: a returning user on a new device crashed
-- on players.eaze_user_id's unique constraint (the upsert only handled
-- conflicts on client_id), and the per-topic-per-day lock was scoped to the
-- trivially-resettable player_id instead of the real identity, so clearing
-- localStorage bypassed it.
--
-- No production data exists yet, so this rewrites session_results directly
-- rather than attempting a backfill for rows that were never reliably tied
-- to a real eaze_user_id in the first place.
DROP INDEX IF EXISTS session_results_one_per_topic_per_day;
DROP TABLE session_results;
DROP TABLE players;

CREATE TABLE session_results (
  id BIGSERIAL PRIMARY KEY,
  eaze_user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  session_number INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  best_streak INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX session_results_eaze_user_id_index ON session_results (eaze_user_id);
CREATE INDEX session_results_topic_id_session_number_index ON session_results (topic_id, session_number);

-- Same "one play per topic per day" rule as before, now scoped to the real
-- identity instead of a client-resettable device id.
CREATE UNIQUE INDEX session_results_one_per_topic_per_day
  ON session_results (eaze_user_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date));

-- down
-- Schema-shape reversal only — data written under the eaze_user_id-keyed
-- table can't be reconstructed into the old client_id/player_id shape.
DROP INDEX IF EXISTS session_results_one_per_topic_per_day;
DROP TABLE session_results;

CREATE TABLE players (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  eaze_user_id TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_results (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players ON DELETE CASCADE,
  topic_id TEXT NOT NULL,
  session_number INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  best_streak INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_results_topic_id_session_number_index ON session_results (topic_id, session_number);
CREATE INDEX session_results_player_id_index ON session_results (player_id);
