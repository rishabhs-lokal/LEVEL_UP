export const shorthands = undefined;

// Closes a real gap: nothing server-side previously stopped the same
// player+topic from being submitted (and scored) more than once in the same
// IST day — only the frontend's localStorage lock pretended that couldn't
// happen. A direct call to POST /api/sessions/complete could rack up
// unlimited +5 events for the same topic. This is the server-side version
// of the same "one play per topic per day" rule, enforced as a real
// constraint instead of trusted client behavior.
//
// Expression index (not a plain unique constraint) because Postgres unique
// CONSTRAINTs can't be built on an expression like a timezone-converted
// date — only unique INDEXes can, and INSERT ... ON CONFLICT can still
// target one by matching its exact expression list.
export const up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX session_results_one_per_topic_per_day
    ON session_results (player_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS session_results_one_per_topic_per_day');
};
