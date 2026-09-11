-- up
-- Replaces the old topic-based session_results with per-card tracking,
-- matching the content model (20 sessions x 15 cards, no topics, one global
-- session per day, 1 EazeScore per card). There's no separate "sessions"
-- table — a completed session is derived as >=15 distinct card_number rows
-- for the same eaze_user_id + IST day, consistent with the event-sourced
-- approach already used for score_events.
DROP TABLE session_results;

CREATE TABLE card_results (
  id BIGSERIAL PRIMARY KEY,
  eaze_user_id TEXT NOT NULL,
  session_number INTEGER NOT NULL,
  card_number INTEGER NOT NULL,
  is_correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX card_results_eaze_user_id_index ON card_results (eaze_user_id);

-- One scoring per card per calendar day (IST) — a session abandoned
-- mid-way can be retried on a later day without losing the points already
-- banked that day, while same-day replay of an already-answered card earns
-- nothing further.
CREATE UNIQUE INDEX card_results_one_per_card_per_day
  ON card_results (eaze_user_id, session_number, card_number, ((created_at AT TIME ZONE 'Asia/Kolkata')::date));

-- down
DROP INDEX IF EXISTS card_results_one_per_card_per_day;
DROP TABLE card_results;

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
CREATE UNIQUE INDEX session_results_one_per_topic_per_day
  ON session_results (eaze_user_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date));
