import { ErrorCode } from '../errors/error-codes.js';

const RETRYABLE_CODES = new Set([ErrorCode.COURIER_TIMEOUT, ErrorCode.COURIER_UNAVAILABLE]);

/**
 * A courier error is worth retrying only if repeating the identical request could plausibly
 * succeed. Timeouts and 5xx qualify; a rejected payload never will, and retrying it just burns
 * the courier's rate limit.
 */
export function isRetryable(err) {
  return RETRYABLE_CODES.has(err?.code);
}

export function backoffDelay(attempt, baseMs) {
  const exponential = baseMs * 2 ** attempt;
  // Full jitter: without it, every worker in a batch retries in lockstep and re-creates the
  // spike that knocked the courier over in the first place.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => Promise<any>} fn
 * @param {object} options
 * @param {number} options.retries additional attempts after the first
 * @param {number} options.baseDelayMs
 * @param {(err: Error) => boolean} [options.shouldRetry]
 * @param {(err: Error, attempt: number, delayMs: number) => void} [options.onRetry]
 */
export async function withRetry(fn, { retries, baseDelayMs, shouldRetry = isRetryable, onRetry }) {
  let attempt = 0;

  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;

      const delayMs = backoffDelay(attempt, baseDelayMs);
      onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
