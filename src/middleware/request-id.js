import { randomUUID } from 'node:crypto';

/**
 * Every request carries an id, echoed in the response body and stamped on every log line it
 * produces. A consumer reporting a problem quotes it, and the whole request is recoverable from
 * the logs. An inbound x-request-id is preserved so a trace survives across services.
 */
export function requestId(req, res, next) {
  req.id = req.get('x-request-id') || `req_${randomUUID()}`;
  res.set('x-request-id', req.id);
  next();
}
