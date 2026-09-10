export const shorthands = undefined;

// Append-only log — one row per session CLOSE (finished or abandoned early),
// not just successful completions (that's session_logs_choices). Captures
// how far the user actually got: cards_engaged (touched, right or wrong) and
// wrong_selections (the subset of those that were wrong), so abandonment can
// be told apart from a clean finish.
export const up = (pgm) => {
  pgm.createTable('open_session_logs', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    cards_engaged: { type: 'integer', notNull: true },
    wrong_selections: { type: 'integer', notNull: true },
    // IST calendar date/wall-clock time this session closed, split into two
    // columns (not one timestamp) — same shape as login_logs_choices and
    // session_logs_choices.
    log_date: { type: 'date', notNull: true },
    log_time: { type: 'time', notNull: true },
  });

  pgm.createIndex('open_session_logs', ['user_id', 'log_date']);
  pgm.createIndex('open_session_logs', ['phone_number']);
};

export const down = (pgm) => {
  pgm.dropTable('open_session_logs');
};
