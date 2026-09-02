export const shorthands = undefined;

// Partial unique index — at most one 'welcome_bonus' row per eaze_user_id.
// Lets the award be a plain `INSERT ... ON CONFLICT (eaze_user_id) WHERE
// event_type = 'welcome_bonus' DO NOTHING`, so "give the first-login bonus"
// is safe to call on every login instead of needing separate check-then-
// insert logic (and the race condition that pattern invites).
export const up = (pgm) => {
  pgm.createIndex('score_events', ['eaze_user_id'], {
    unique: true,
    where: "event_type = 'welcome_bonus'",
    name: 'score_events_one_welcome_bonus_per_user',
  });
};

export const down = (pgm) => {
  pgm.dropIndex('score_events', ['eaze_user_id'], {
    name: 'score_events_one_welcome_bonus_per_user',
  });
};
