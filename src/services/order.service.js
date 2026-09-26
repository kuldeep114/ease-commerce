import { randomUUID } from 'node:crypto';

import * as orderRepo from '../db/repositories/order.repository.js';
import * as trackingRepo from '../db/repositories/tracking.repository.js';
import { getCourier } from '../couriers/registry.js';
import { AppError, NotFoundError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { ShipmentStatus, isCancellable } from '../utils/status.js';
import { logger } from '../utils/logger.js';

/**
 * Business logic for orders. Note what is absent: any mention of a specific courier. The
 * adapter arrives from the registry and is used through the contract, which is what lets a new
 * courier be added without touching this file.
 */

/** The reason stored on a failed order — our normalized wording, never the courier's. */
function failureReason(err) {
  return `${err.code ?? ErrorCode.INTERNAL_ERROR}: ${err.message}`;
}

export async function createOrder(input, { batchId = null } = {}) {
  const adapter = getCourier(input.courier_partner);

  // Claim the order_id before calling the courier. If this loses the race, some other request
  // owns this order and we must not create a second shipment for it.
  const { claimed, order } = await orderRepo.claimForCreation({
    id: randomUUID(),
    order_id: input.order_id,
    courier_partner: adapter.name,
    status: ShipmentStatus.PENDING,
    request_payload: JSON.stringify(input),
    batch_id: batchId,
  });

  if (!claimed) {
    throw new AppError(ErrorCode.DUPLICATE_ORDER, `Order "${input.order_id}" already exists`, {
      details: {
        order_id: order.order_id,
        status: order.status,
        awb_number: order.awb_number,
        courier_partner: order.courier_partner,
      },
    });
  }

  try {
    const result = await adapter.createShipment(input);

    const saved = await orderRepo.updateByOrderId(input.order_id, {
      courier_order_id: result.courierOrderId,
      awb_number: result.awbNumber,
      status: result.status ?? ShipmentStatus.CREATED,
      label_url: result.labelUrl,
      request_payload: JSON.stringify(result.request ?? input),
      response_payload: JSON.stringify(result.raw ?? null),
      failure_reason: null,
    });

    await trackingRepo.appendEvents(saved.id, [
      {
        status: saved.status,
        code: 'CREATED',
        description: 'Shipment created with courier',
        location: null,
        occurredAt: new Date(),
        raw: result.raw ?? null,
      },
    ]);

    logger.info(
      { order_id: saved.order_id, courier_partner: saved.courier_partner, awb_number: saved.awb_number },
      'Shipment created',
    );
    return saved;
  } catch (err) {
    // Persisting the failure is what makes it reconcilable: the order is on record as FAILED
    // with a reason, and the raw courier exchange is kept for debugging. Losing it here would
    // leave the consumer with an order_id that exists nowhere.
    await orderRepo.updateByOrderId(input.order_id, {
      status: ShipmentStatus.FAILED,
      failure_reason: failureReason(err),
      request_payload: JSON.stringify(err.courierRequest ?? input),
      response_payload: err.courierResponse ? JSON.stringify(err.courierResponse) : null,
    });

    logger.error(
      {
        order_id: input.order_id,
        courier_partner: adapter.name,
        error_type: err.code ?? 'UNEXPECTED',
        courier_message: err.courierMessage ?? null,
        err,
      },
      'Shipment creation failed',
    );
    throw err;
  }
}

async function requireOrder(orderId) {
  const order = await orderRepo.findByOrderId(orderId);
  if (!order) {
    throw new NotFoundError(ErrorCode.ORDER_NOT_FOUND, `No order found with order_id "${orderId}"`);
  }
  return order;
}

export async function getOrder(orderId) {
  return requireOrder(orderId);
}

export async function trackOrder(orderId) {
  const order = await requireOrder(orderId);

  // Nothing to ask the courier about until a shipment exists; return what we already hold.
  if (!order.awb_number) {
    return { order, history: await trackingRepo.listByOrderId(order.id) };
  }

  const adapter = getCourier(order.courier_partner);
  const result = await adapter.trackShipment(order.awb_number);

  await trackingRepo.appendEvents(order.id, result.history);

  // Only the status is refreshed here: response_payload holds the creation exchange, and
  // overwriting it would destroy that audit record. Raw tracking payloads live on each
  // tracking_history row instead.
  const updated =
    result.status && result.status !== order.status
      ? await orderRepo.updateByOrderId(orderId, { status: result.status })
      : order;

  return {
    order: updated,
    history: await trackingRepo.listByOrderId(order.id),
    current_location: result.currentLocation ?? null,
    estimated_delivery: result.estimatedDelivery ?? null,
  };
}

export async function cancelOrder(orderId) {
  const order = await requireOrder(orderId);

  // Cancelling an already-cancelled order is a no-op, not an error — the caller's intent is
  // already satisfied and repeating the request should stay safe.
  if (order.status === ShipmentStatus.CANCELLED) return order;

  if (!isCancellable(order.status)) {
    throw new AppError(
      ErrorCode.ORDER_NOT_CANCELLABLE,
      `Order "${orderId}" cannot be cancelled while it is ${order.status}`,
    );
  }

  if (!order.awb_number) {
    throw new AppError(
      ErrorCode.ORDER_NOT_CANCELLABLE,
      `Order "${orderId}" has no shipment with the courier yet`,
    );
  }

  const adapter = getCourier(order.courier_partner);
  const result = await adapter.cancelShipment(order.awb_number);

  const updated = await orderRepo.updateByOrderId(orderId, { status: ShipmentStatus.CANCELLED });

  await trackingRepo.appendEvents(order.id, [
    {
      status: ShipmentStatus.CANCELLED,
      code: 'CANCELLED',
      description: result.message ?? 'Shipment cancelled',
      location: null,
      occurredAt: new Date(),
      raw: result.raw ?? null,
    },
  ]);

  logger.info({ order_id: orderId, courier_partner: order.courier_partner }, 'Shipment cancelled');
  return updated;
}
