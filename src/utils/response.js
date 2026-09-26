/** The one success envelope. Its error twin lives in middleware/error-handler.js. */
export function success(req, data) {
  return {
    success: true,
    data,
    request_id: req.id,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Shapes an order row for the API.
 *
 * `request_payload` and `response_payload` are deliberately absent: they exist for audit and
 * contain the courier's raw wording, which §3.5 says must never reach a consumer.
 */
export function presentOrder(order) {
  return {
    order_id: order.order_id,
    courier_partner: order.courier_partner,
    courier_order_id: order.courier_order_id,
    awb_number: order.awb_number,
    status: order.status,
    label_url: order.label_url,
    failure_reason: order.failure_reason,
    created_at: order.created_at,
    updated_at: order.updated_at,
  };
}

export function presentTrackingEvent(event) {
  return {
    status: event.status,
    courier_status_code: event.courier_status_code,
    description: event.courier_status_description,
    location: event.location,
    occurred_at: event.occurred_at,
  };
}

export function presentBatch(batch, items) {
  // Counts come from the item rows, not the columns on `batches`. Those columns are only
  // written once the batch finishes, so reading them mid-flight would report no progress at
  // all while ten workers are busy.
  const tally = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    batch_id: batch.batch_id,
    status: batch.status,
    total_count: batch.total_count,
    success_count: tally.SUCCESS ?? 0,
    failure_count: tally.FAILED ?? 0,
    pending_count: tally.PENDING ?? 0,
    created_at: batch.created_at,
    completed_at: batch.completed_at,
    results: items.map((item) => ({
      index: item.item_index,
      order_id: item.order_id,
      status: item.status,
      awb_number: item.awb_number,
      error: item.error_code ? { code: item.error_code, message: item.error_message } : null,
    })),
  };
}
