export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('players', {
    id: { type: 'bigserial', primaryKey: true },
    client_id: { type: 'text', notNull: true, unique: true },
    eaze_user_id: { type: 'text', unique: true },
    display_name: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

export const down = (pgm) => {
  pgm.dropTable('players');
};
