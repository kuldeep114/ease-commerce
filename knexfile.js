import { config } from './src/config/index.js';

export default {
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
  migrations: {
    directory: './src/db/migrations',
    // Migrations are .mjs so knex loads them with import() rather than require(), which is
    // what an ESM package needs.
    loadExtensions: ['.mjs'],
    tableName: 'knex_migrations',
  },
};
