export const shorthands = undefined;

// Append-only ledger — the shared source of truth for EazeScore across every
// app that reports into it (this one, eaze-checkin, and whatever else comes
// later). Total score is always SUM(points) over these rows, never a stored
// mutable counter, so it can't drift or get clobbered by a race condition.
export const up = (pgm) => {
  pgm.createTable('score_events', {
    id: { type: 'bigserial', primaryKey: true },
    eaze_user_id: { type: 'text', notNull: true },
    source_app: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    points: { type: 'integer', notNull: true },
    metadata: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('score_events', ['eaze_user_id']);
};

export const down = (pgm) => {
  pgm.dropTable('score_events');
};
