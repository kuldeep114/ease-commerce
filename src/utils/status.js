/**
 * Normalized shipment lifecycle. Every courier's vocabulary is mapped onto this set, so
 * consumers never branch on a courier-specific code.
 *
 * PENDING is ours alone: the order row is written before the courier is called, which is what
 * makes creation idempotent. It means "accepted, not yet acknowledged by the courier".
 */
export const ShipmentStatus = {
  PENDING: 'PENDING',
  CREATED: 'CREATED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  RTO: 'RTO',
  FAILED: 'FAILED',
};

/** Statuses past which a cancellation request is pointless. */
const UNCANCELLABLE = new Set([
  ShipmentStatus.DELIVERED,
  ShipmentStatus.CANCELLED,
  ShipmentStatus.RTO,
]);

export function isCancellable(status) {
  return !UNCANCELLABLE.has(status);
}
