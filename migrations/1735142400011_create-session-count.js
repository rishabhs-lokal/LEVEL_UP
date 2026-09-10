export const shorthands = undefined;

// Append-only log — one row per session a user actually engages with,
// firing on the first card answered for that session_number/day (mirrors
// session_logs_choices, which fires on the last card instead). Multiple rows
// can share the same session_number over time — sessions rotate 1..20 and
// repeat as the user comes back day after day, so this is a play-log, not a
// per-session-number unique record.
export const up = (pgm) => {
  pgm.createTable('session_count', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    session_number: { type: 'integer', notNull: true },
    log_date: { type: 'date', notNull: true },
    log_time: { type: 'time', notNull: true },
  });

  pgm.createIndex('session_count', ['user_id', 'log_date']);
  pgm.createIndex('session_count', ['phone_number']);
};

export const down = (pgm) => {
  pgm.dropTable('session_count');
};
