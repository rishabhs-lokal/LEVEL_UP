-- up
-- Append-only ledger — the shared source of truth for EazeScore across every
-- app that reports into it (this one, eaze-checkin, and whatever else comes
-- later). Total score is always SUM(points) over these rows, never a stored
-- mutable counter, so it can't drift or get clobbered by a race condition.
CREATE TABLE score_events (
  id BIGSERIAL PRIMARY KEY,
  eaze_user_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  event_type TEXT NOT NULL,
  points INTEGER NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX score_events_eaze_user_id_index ON score_events (eaze_user_id);

-- down
DROP TABLE score_events;
