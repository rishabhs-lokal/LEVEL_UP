export const shorthands = undefined;

// First-login-only tracking — one row per user, ever. Mirrors eaze-checkin's
// own login_logs table (same first_login_date/first_login_time-as-separate-
// IST-columns shape, same one-row-per-user invariant), adapted to this app's
// identity model: user_id here is the real Eaze platform user id (distinct
// from phone_number — resolved via the host app's banner entry, not
// something this app generates), tracked separately rather than reusing the
// phone-number-based eazeUserId that score_events/card_results key on.
export const up = (pgm) => {
  pgm.createTable('login_logs_choices', {
    id: { type: 'bigserial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    phone_number: { type: 'text', notNull: true },
    // IST calendar date/wall-clock time of the user's first-ever login,
    // split into two columns (not one timestamp) — same shape as
    // eaze-checkin's first_login_date/first_login_time, computed once at
    // insert time rather than stored as UTC and converted on every read.
    first_login_date: { type: 'date', notNull: true },
    first_login_time: { type: 'time', notNull: true },
  });

  pgm.addConstraint('login_logs_choices', 'login_logs_choices_user_id_key', {
    unique: ['user_id'],
  });
  pgm.createIndex('login_logs_choices', ['phone_number']);
};

export const down = (pgm) => {
  pgm.dropTable('login_logs_choices');
};
