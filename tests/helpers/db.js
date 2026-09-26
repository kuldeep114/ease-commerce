import { db } from '../../src/db/knex.js';

/**
 * One statement resets every table and restarts the identity sequences, so no test can see a
 * row — or an id — left behind by another.
 */
export async function resetDatabase() {
  await db.raw('TRUNCATE TABLE tracking_history, batch_items, orders, batches RESTART IDENTITY CASCADE');
}

export function closeDatabase() {
  return db.destroy();
}

export { db };
