export const shorthands = undefined;

// Replaces the old topic-based session_results with per-card tracking,
// matching the new content model (20 sessions x 15 cards, no topics, one
// global session per day, 1 EazeScore per card). There's no separate
// "sessions" table — a completed session is derived as >=15 distinct
// card_number rows for the same eaze_user_id + IST day, consistent with the
// event-sourced approach already used for score_events.
export const up = (pgm) => {
  pgm.dropTable('session_results');

  pgm.createTable('card_results', {
    id: { type: 'bigserial', primaryKey: true },
    eaze_user_id: { type: 'text', notNull: true },
    session_number: { type: 'integer', notNull: true },
    card_number: { type: 'integer', notNull: true },
    is_correct: { type: 'boolean', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('card_results', ['eaze_user_id']);

  // One scoring per card per calendar day (IST) — a session abandoned
  // mid-way can be retried on a later day without losing the points already
  // banked that day, while same-day replay of an already-answered card
  // earns nothing further.
  pgm.sql(`
    CREATE UNIQUE INDEX card_results_one_per_card_per_day
    ON card_results (eaze_user_id, session_number, card_number, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS card_results_one_per_card_per_day');
  pgm.dropTable('card_results');

  pgm.createTable('session_results', {
    id: { type: 'bigserial', primaryKey: true },
    eaze_user_id: { type: 'text', notNull: true },
    topic_id: { type: 'text', notNull: true },
    session_number: { type: 'integer', notNull: true },
    correct_count: { type: 'integer', notNull: true },
    total_count: { type: 'integer', notNull: true },
    best_streak: { type: 'integer', notNull: true, default: 0 },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('session_results', ['eaze_user_id']);
  pgm.createIndex('session_results', ['topic_id', 'session_number']);
  pgm.sql(`
    CREATE UNIQUE INDEX session_results_one_per_topic_per_day
    ON session_results (eaze_user_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
  `);
};
