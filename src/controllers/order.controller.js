import * as bulkService from '../services/bulk.service.js';
import * as orderService from '../services/order.service.js';
import { asyncHandler } from '../middleware/validate.js';
import { presentBatch, presentOrder, presentTrackingEvent, success } from '../utils/response.js';

// Controllers stay thin on purpose: take the validated input, call the service, shape the
// response. No business logic, no courier knowledge, no error handling of their own.

export const create = asyncHandler(async (req, res) => {
  const order = await orderService.createOrder(req.validated);
  res.status(201).json(success(req, presentOrder(order)));
});

export const get = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.params.order_id);
  res.json(success(req, presentOrder(order)));
});

export const track = asyncHandler(async (req, res) => {
  const { order, history, current_location, estimated_delivery } = await orderService.trackOrder(
    req.params.order_id,
  );

  res.json(
    success(req, {
      ...presentOrder(order),
      current_location: current_location ?? null,
      estimated_delivery: estimated_delivery ?? null,
      tracking_history: history.map(presentTrackingEvent),
    }),
  );
});

export const cancel = asyncHandler(async (req, res) => {
  const order = await orderService.cancelOrder(req.params.order_id);
  res.json(success(req, presentOrder(order)));
});

export const createBulk = asyncHandler(async (req, res) => {
  const result = await bulkService.createBulk(req.validated.orders);
  // 202, not 201: the batch is accepted, the shipments do not exist yet.
  res.status(202).json(success(req, result));
});

export const getBulk = asyncHandler(async (req, res) => {
  const { batch, items } = await bulkService.getBatch(req.params.batch_id);
  res.json(success(req, presentBatch(batch, items)));
});
