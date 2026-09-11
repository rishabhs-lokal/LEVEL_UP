-- up
-- Expression index (not a plain unique constraint) because Postgres unique
-- CONSTRAINTs can't be built on an expression like a timezone-converted
-- date — only unique INDEXes can, and INSERT ... ON CONFLICT can still
-- target one by matching its exact expression list.
CREATE UNIQUE INDEX session_results_one_per_topic_per_day
  ON session_results (player_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date));

-- down
DROP INDEX IF EXISTS session_results_one_per_topic_per_day;
