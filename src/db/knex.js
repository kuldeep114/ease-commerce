import knexFactory from 'knex';
import knexConfig from '../../knexfile.js';

export const db = knexFactory(knexConfig);

export async function verifyConnection() {
  await db.raw('select 1');
}

export async function closeConnection() {
  await db.destroy();
}
