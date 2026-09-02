export const shorthands = undefined;

// Simplifies the identity model: eaze_user_id (the phone number) is the only
// identity this app actually needs. Login is mandatory before a session can
// ever complete, so it's always available by the time session_results gets
// written to — client_id/player_id/the players table were built earlier,
// before eaze_user_id existed, as an anonymous per-device fallback. They'd
// become pure redundant indirection once login became mandatory, and were
// the actual source of two real bugs: a returning user on a new device
// crashed on players.eaze_user_id's unique constraint (the upsert only
// handled conflicts on client_id), and the per-topic-per-day lock was
// scoped to the trivially-resettable player_id instead of the real
// identity, so clearing localStorage bypassed it.
//
// No production data exists yet, so this rewrites session_results directly
// rather than attempting a backfill for rows that were never reliably tied
// to a real eaze_user_id in the first place.
export const up = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS session_results_one_per_topic_per_day');
  pgm.dropTable('session_results');
  pgm.dropTable('players');

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

  // Same "one play per topic per day" rule as before, now scoped to the
  // real identity instead of a client-resettable device id — this is what
  // actually closes the abuse gap, not just the crash.
  pgm.sql(`
    CREATE UNIQUE INDEX session_results_one_per_topic_per_day
    ON session_results (eaze_user_id, topic_id, ((created_at AT TIME ZONE 'Asia/Kolkata')::date))
  `);
};

export const down = (pgm) => {
  // Schema-shape reversal only — data written under the eaze_user_id-keyed
  // table can't be reconstructed into the old client_id/player_id shape.
  pgm.sql('DROP INDEX IF EXISTS session_results_one_per_topic_per_day');
  pgm.dropTable('session_results');

  pgm.createTable('players', {
    id: { type: 'bigserial', primaryKey: true },
    client_id: { type: 'text', notNull: true, unique: true },
    eaze_user_id: { type: 'text', unique: true },
    display_name: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('session_results', {
    id: { type: 'bigserial', primaryKey: true },
    player_id: { type: 'bigint', notNull: true, references: 'players', onDelete: 'CASCADE' },
    topic_id: { type: 'text', notNull: true },
    session_number: { type: 'integer', notNull: true },
    correct_count: { type: 'integer', notNull: true },
    total_count: { type: 'integer', notNull: true },
    best_streak: { type: 'integer', notNull: true, default: 0 },
    duration_ms: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('session_results', ['topic_id', 'session_number']);
  pgm.createIndex('session_results', ['player_id']);
};
