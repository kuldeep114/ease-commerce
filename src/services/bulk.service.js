import { randomUUID } from 'node:crypto';

import * as batchRepo from '../db/repositories/batch.repository.js';
import { BatchItemStatus, BatchStatus } from '../db/repositories/batch.repository.js';
import * as orderService from './order.service.js';
import { config } from '../config/index.js';
import { createOrderSchema } from '../schemas/order.schema.js';
import { NotFoundError, ValidationError, toAppError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { logger } from '../utils/logger.js';

/**
 * Bulk creation.
 *
 * The endpoint accepts the batch, answers 202 with a batch_id, and processes in the background
 * through a bounded concurrency pool. Trade-offs are documented in DESIGN.md; the short version
 * is that an in-process pool meets every stated requirement with no extra infrastructure, at the
 * cost of durability across a restart.
 */

// Batches currently being processed, so shutdown can drain them and tests can await one
// instead of polling.
const inFlight = new Map();

/** Resolves once the given batch has finished, or immediately if it is not running here. */
export function waitForBatch(batchId) {
  return inFlight.get(batchId) ?? Promise.resolve();
}

export function drainBatches() {
  return Promise.all([...inFlight.values()]);
}

/** Validates each item on its own so one malformed order cannot reject the whole submission. */
function parseItems(rawOrders) {
  return rawOrders.map((raw, index) => {
    const parsed = createOrderSchema.safeParse(raw);
    // Falls back to the raw order_id purely so a rejected item is still identifiable in the
    // result, even when it failed validation for some other reason.
    const orderId = typeof raw?.order_id === 'string' ? raw.order_id.trim().slice(0, 64) : null;

    return parsed.success
      ? { index, orderId: parsed.data.order_id, input: parsed.data, error: null }
      : { index, orderId, input: null, error: ValidationError.fromZod(parsed.error) };
  });
}

export async function createBulk(rawOrders) {
  const batchId = randomUUID();
  const items = parseItems(rawOrders);
  const accepted = items.filter((item) => item.input);

  await batchRepo.createBatch({ batchId, totalCount: items.length });
  await batchRepo.insertItems(
    items.map((item) => ({
      batch_id: batchId,
      item_index: item.index,
      order_id: item.orderId,
      status: item.error ? BatchItemStatus.FAILED : BatchItemStatus.PENDING,
      error_code: item.error?.code ?? null,
      error_message: item.error ? describe(item.error) : null,
    })),
  );

  // Deliberately not awaited: the whole point of returning 202 is that the caller does not wait
  // for a hundred courier round trips. The promise is kept so shutdown (and tests) can wait for
  // it, and any escaping error is logged rather than lost — there is no request left to attach
  // it to by the time it happens.
  const running = processBatch(batchId, accepted)
    .catch((err) => logger.error({ batch_id: batchId, err }, 'Batch processing failed unexpectedly'))
    .finally(() => inFlight.delete(batchId));
  inFlight.set(batchId, running);

  return {
    batch_id: batchId,
    status: BatchStatus.QUEUED,
    total_count: items.length,
    accepted_count: accepted.length,
    rejected_count: items.length - accepted.length,
    status_url: `/api/v1/orders/bulk/${batchId}`,
  };
}

function describe(err) {
  if (err.code !== ErrorCode.VALIDATION_ERROR || !Array.isArray(err.details)) return err.message;
  return err.details.map((detail) => `${detail.field}: ${detail.message}`).join('; ');
}

async function processBatch(batchId, items) {
  if (items.length === 0) {
    await batchRepo.complete(batchId);
    return;
  }

  await batchRepo.setStatus(batchId, BatchStatus.PROCESSING);

  await runWithConcurrency(items, config.bulk.concurrency, async (item) => {
    try {
      // The same service call the single-order endpoint uses, so the two paths cannot drift —
      // and so a batch may freely mix couriers, since the adapter is resolved per order.
      const order = await orderService.createOrder(item.input, { batchId });
      await batchRepo.markItem(batchId, item.index, {
        status: BatchItemStatus.SUCCESS,
        order_id: order.order_id,
        awb_number: order.awb_number,
        error_code: null,
        error_message: null,
      });
    } catch (err) {
      const appError = toAppError(err);
      await batchRepo.markItem(batchId, item.index, {
        status: BatchItemStatus.FAILED,
        error_code: appError.code,
        error_message: appError.message,
      });
    }
  });

  await batchRepo.complete(batchId);
  logger.info({ batch_id: batchId, processed: items.length }, 'Batch processing finished');
}

export async function getBatch(batchId) {
  const batch = await batchRepo.findBatch(batchId);
  if (!batch) {
    throw new NotFoundError(ErrorCode.BATCH_NOT_FOUND, `No batch found with batch_id "${batchId}"`);
  }
  return { batch, items: await batchRepo.findItems(batchId) };
}
