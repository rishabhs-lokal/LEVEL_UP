export const shorthands = undefined;

// Append-only snapshot log — one row per successfully completed session
// (not a mutable counter), mirroring eaze-checkin's own cumulative-tracking
// tables (eazescore_cumulative_logs, streak_log): each row captures the
// user's lifetime sessions_count AS OF that completion, so the full history
// of how it grew over time is preserved, not just the current total.
export const up = (pgm) => {
  pgm.createTable('session_logs_choices', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    sessions_count: { type: 'integer', notNull: true },
    // IST calendar date/wall-clock time this session was completed, split
    // into two columns (not one timestamp) — same shape as
    // login_logs_choices and eaze-checkin's own log tables.
    log_date: { type: 'date', notNull: true },
    log_time: { type: 'time', notNull: true },
  });

  pgm.createIndex('session_logs_choices', ['user_id', 'log_date']);
  pgm.createIndex('session_logs_choices', ['phone_number']);
};

export const down = (pgm) => {
  pgm.dropTable('session_logs_choices');
};
