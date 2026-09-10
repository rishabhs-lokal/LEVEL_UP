export const shorthands = undefined;

// Append-only log — one row per successful coin claim (POST
// /api/score/claim), capturing the EazeScore balance that was converted at
// claim time. Same conventions as login_logs_choices / session_logs_choices
// / open_session_logs: banner-entered users only (real user_id, never
// fabricated for the typed-phone dev login path), IST date/time split into
// two columns.
export const up = (pgm) => {
  pgm.createTable('claim_choices', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    eazescore_claimed: { type: 'integer', notNull: true },
    log_date: { type: 'date', notNull: true },
    log_time: { type: 'time', notNull: true },
  });

  pgm.createIndex('claim_choices', ['user_id', 'log_date']);
  pgm.createIndex('claim_choices', ['phone_number']);
};

export const down = (pgm) => {
  pgm.dropTable('claim_choices');
};
