import { db } from '../knex.js';
import { ShipmentStatus } from '../../utils/status.js';

const TABLE = 'orders';
const PG_UNIQUE_VIOLATION = '23505';

export function findByOrderId(orderId) {
  return db(TABLE).where({ order_id: orderId }).first();
}

export async function updateByOrderId(orderId, patch) {
  const [updated] = await db(TABLE)
    .where({ order_id: orderId })
    .update({ ...patch, updated_at: db.fn.now() })
    .returning('*');
  return updated;
}

/**
 * Takes exclusive ownership of an order_id before the courier is called.
 *
 * Insert-first is what guarantees idempotency: two concurrent requests for the same order_id
 * cannot both win, because the database rejects the second. A read-then-write check would let
 * both through under exactly the concurrency the bulk endpoint creates.
 *
 * @returns {Promise<{claimed: boolean, order: object}>} `claimed: false` means a shipment for
 *   this order_id already exists and the caller must not create another.
 */
export async function claimForCreation(row) {
  try {
    const [order] = await db(TABLE).insert(row).returning('*');
    return { claimed: true, order };
  } catch (err) {
    if (err.code !== PG_UNIQUE_VIOLATION) throw err;
  }

  // A previous attempt that ended in FAILED never produced a shipment, so resubmitting the same
  // order_id is a retry rather than a duplicate. Guarding the UPDATE on that status keeps the
  // claim atomic when two retries arrive together — only one row update can match.
  const [retried] = await db(TABLE)
    .where({ order_id: row.order_id, status: ShipmentStatus.FAILED })
    .update({
      courier_partner: row.courier_partner,
      status: ShipmentStatus.PENDING,
      request_payload: row.request_payload,
      batch_id: row.batch_id,
      failure_reason: null,
      retry_count: db.raw('retry_count + 1'),
      updated_at: db.fn.now(),
    })
    .returning('*');

  if (retried) return { claimed: true, order: retried };

  return { claimed: false, order: await findByOrderId(row.order_id) };
}
