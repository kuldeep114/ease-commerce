import { ErrorCode, HTTP_STATUS_BY_CODE } from './error-codes.js';

export class AppError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message safe to return to an API consumer
   * @param {object} [options]
   * @param {object|Array} [options.details] field-level detail returned to the consumer
   * @param {string} [options.courierMessage] the courier's own wording — logged, never returned
   * @param {object} [options.courierRequest] exact body sent to the courier, for the audit trail
   * @param {object} [options.courierResponse] exact body received from the courier
   * @param {Error} [options.cause]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code] ?? 500;
    this.details = options.details ?? null;
    this.courier = options.courier ?? null;
    this.courierMessage = options.courierMessage ?? null;
    this.courierRequest = options.courierRequest ?? null;
    this.courierResponse = options.courierResponse ?? null;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(ErrorCode.VALIDATION_ERROR, message, { details });
  }

  /** Flattens a Zod error into the `[{ field, message }]` shape the API contract promises. */
  static fromZod(zodError) {
    const details = zodError.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    return new ValidationError('Request validation failed', details);
  }
}

export class NotFoundError extends AppError {
  constructor(code, message) {
    super(code, message);
  }
}

/**
 * Raised by courier adapters. Carries the courier's raw wording and payloads separately from
 * `message` so the error handler can log everything while returning only the normalized text.
 */
export class CourierError extends AppError {}

/** Normalizes anything thrown anywhere into an AppError the error handler can render. */
export function toAppError(err) {
  if (err instanceof AppError) return err;

  // express.json() rejects malformed bodies before any of our middleware sees them.
  if (err?.type === 'entity.parse.failed') {
    return new ValidationError('Request body is not valid JSON', null);
  }
  if (err?.type === 'entity.too.large') {
    return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large');
  }

  // Anything unrecognised is a bug on our side: the consumer gets a generic message, while the
  // original error is preserved as `cause` for the log line.
  return new AppError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred', { cause: err });
}
