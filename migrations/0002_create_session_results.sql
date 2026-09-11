-- up
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

-- down
DROP TABLE session_results;
