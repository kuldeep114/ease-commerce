import { timingSafeEqual } from 'node:crypto';

import { config } from '../config/index.js';
import { AppError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';

function matches(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, which throws on differing lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Shared-secret auth for internal consumers. This is a service-to-service API, so a static key
 * is proportionate — per-consumer credentials would be the next step if the caller list grew.
 */
export function apiKeyAuth(req, res, next) {
  const provided = req.get('x-api-key');

  if (!provided || !matches(provided, config.apiKey)) {
    return next(new AppError(ErrorCode.UNAUTHORIZED, 'A valid x-api-key header is required'));
  }
  return next();
}
