import { AppError, toAppError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { logger } from '../utils/logger.js';

export function notFound(req, res, next) {
  next(new AppError(ErrorCode.NOT_FOUND, `No route matches ${req.method} ${req.originalUrl}`));
}

/**
 * The only place in the codebase that renders an error response. Controllers and services throw;
 * the shape is decided once, here, so it cannot drift between endpoints.
 */
// The unused `next` is required: Express identifies error middleware by its arity.
export function errorHandler(err, req, res, next) {
  const error = toAppError(err);

  const context = {
    request_id: req.id,
    order_id: req.params?.order_id ?? req.body?.order_id ?? null,
    courier_partner: req.body?.courier_partner ?? error.courier ?? null,
    error_type: error.code,
    // The courier's own wording is recorded here and nowhere else — it must not reach the
    // consumer, but losing it would make courier failures undebuggable.
    courier_message: error.courierMessage ?? null,
  };

  if (error.status >= 500) {
    // Stack traces matter for our own bugs and for courier outages; `cause` carries the
    // original error when it was something unexpected.
    logger.error({ ...context, err: error.cause ?? error }, error.message);
  } else {
    logger.warn(context, error.message);
  }

  res.status(error.status).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
    request_id: req.id,
    timestamp: new Date().toISOString(),
  });
}
