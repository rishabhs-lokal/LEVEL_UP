export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('session_results', {
    id: { type: 'bigserial', primaryKey: true },
    player_id: {
      type: 'bigint',
      notNull: true,
      references: 'players',
      onDelete: 'CASCADE',
    },
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

export const down = (pgm) => {
  pgm.dropTable('session_results');
};
