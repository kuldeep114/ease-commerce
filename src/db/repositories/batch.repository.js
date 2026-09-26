import { db } from '../knex.js';

const BATCHES = 'batches';
const ITEMS = 'batch_items';

export const BatchStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
};

export const BatchItemStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

export async function createBatch({ batchId, totalCount }) {
  const [batch] = await db(BATCHES)
    .insert({ batch_id: batchId, status: BatchStatus.QUEUED, total_count: totalCount })
    .returning('*');
  return batch;
}

export function insertItems(rows) {
  return db(ITEMS).insert(rows);
}

export function setStatus(batchId, status) {
  return db(BATCHES).where({ batch_id: batchId }).update({ status });
}

export function markItem(batchId, itemIndex, patch) {
  return db(ITEMS)
    .where({ batch_id: batchId, item_index: itemIndex })
    .update({ ...patch, updated_at: db.fn.now() });
}

/**
 * Derives the final counts from the item rows rather than incrementing counters as results
 * arrive — with ten workers writing concurrently, read-modify-write counters would drift.
 */
export async function complete(batchId) {
  const counts = await db(ITEMS)
    .where({ batch_id: batchId })
    .select('status')
    .count('* as count')
    .groupBy('status');

  const tally = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));

  await db(BATCHES).where({ batch_id: batchId }).update({
    status: BatchStatus.COMPLETED,
    success_count: tally[BatchItemStatus.SUCCESS] ?? 0,
    failure_count: tally[BatchItemStatus.FAILED] ?? 0,
    completed_at: db.fn.now(),
  });
}

export function findBatch(batchId) {
  return db(BATCHES).where({ batch_id: batchId }).first();
}

export function findItems(batchId) {
  return db(ITEMS).where({ batch_id: batchId }).orderBy('item_index');
}
