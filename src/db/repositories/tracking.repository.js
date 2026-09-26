import { db } from '../knex.js';

const TABLE = 'tracking_history';

/**
 * Append-only by construction: this module exposes no update and no delete, so there is no
 * code path anywhere in the service that can rewrite shipment history.
 *
 * @param {string} orderId internal orders.id
 * @param {Array<{status, code, description, location, occurredAt, raw}>} events
 * @returns {Promise<number>} how many events were new
 */
export async function appendEvents(orderId, events) {
  if (!events?.length) return 0;

  const rows = events.map((event) => ({
    order_id: orderId,
    status: event.status,
    courier_status_code: event.code,
    courier_status_description: event.description ?? null,
    location: event.location || null,
    occurred_at: event.occurredAt,
    raw_payload: event.raw ? JSON.stringify(event.raw) : null,
  }));

  // Re-polling replays scans we already hold; ignoring the conflict is cheaper than reading
  // first and keeps the write a single round trip.
  const inserted = await db(TABLE)
    .insert(rows)
    .onConflict(['order_id', 'courier_status_code', 'occurred_at'])
    .ignore()
    .returning('id');

  return inserted.length;
}

export function listByOrderId(orderId) {
  return db(TABLE).where({ order_id: orderId }).orderBy([
    { column: 'occurred_at', order: 'desc' },
    { column: 'id', order: 'desc' },
  ]);
}
