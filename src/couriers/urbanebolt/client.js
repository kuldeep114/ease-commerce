import axios from 'axios';

import { CourierError } from '../../errors/app-error.js';
import { ErrorCode } from '../../errors/error-codes.js';
import { isRetryable, withRetry } from '../../utils/retry.js';
import { logger } from '../../utils/logger.js';

const AUTH_PATH = '/api/v1/auth/getToken/';
const COURIER = 'urbanebolt';

// Refresh slightly before the courier's own expiry so a token cannot lapse mid-flight.
const EXPIRY_SKEW_MS = 60_000;

/**
 * Translates a transport-level failure into one of our normalized error codes. Doing it here
 * means the adapter and everything above it never inspect an axios error.
 */
function toCourierError(err, { path }) {
  if (err instanceof CourierError) return err;

  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return new CourierError(ErrorCode.COURIER_TIMEOUT, 'Courier did not respond in time', {
      courier: COURIER,
      courierMessage: err.message,
    });
  }

  if (!err.response) {
    return new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'Could not reach the courier', {
      courier: COURIER,
      courierMessage: err.message,
    });
  }

  const { status, data } = err.response;
  const courierMessage = typeof data === 'string' ? data : (data?.detail ?? data?.message ?? JSON.stringify(data));

  if (status === 401 || status === 403) {
    return new CourierError(ErrorCode.COURIER_AUTH_ERROR, 'Courier rejected our credentials', {
      courier: COURIER,
      courierMessage,
      courierResponse: data,
    });
  }

  if (status === 429 || status >= 500) {
    return new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'Courier is temporarily unavailable', {
      courier: COURIER,
      courierMessage,
      courierResponse: data,
    });
  }

  return new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier rejected the request', {
    courier: COURIER,
    courierMessage: `${path}: ${courierMessage}`,
    courierResponse: data,
  });
}

export function createClient(settings) {
  const http = axios.create({
    baseURL: settings.baseUrl,
    timeout: settings.timeoutMs,
    headers: { 'Content-Type': 'application/json' },
  });

  let cachedToken = null; // { value, expiresAt }

  async function authenticate() {
    try {
      const { data } = await http.post(AUTH_PATH, {
        username: settings.username,
        password: settings.password,
      });

      if (!data?.access_token) {
        throw new CourierError(ErrorCode.COURIER_AUTH_ERROR, 'Courier returned no access token', {
          courier: COURIER,
          courierResponse: data,
        });
      }

      const lifetimeMs = Number(data.expires_in ?? 3600) * 1000;
      cachedToken = { value: data.access_token, expiresAt: Date.now() + lifetimeMs - EXPIRY_SKEW_MS };
      return cachedToken.value;
    } catch (err) {
      throw toCourierError(err, { path: AUTH_PATH });
    }
  }

  async function getToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    return authenticate();
  }

  async function send(requestConfig) {
    return withRetry(
      async () => {
        const token = await getToken();
        try {
          const { data } = await http.request({
            ...requestConfig,
            headers: { ...requestConfig.headers, Authorization: `Bearer ${token}` },
          });
          return data;
        } catch (err) {
          throw toCourierError(err, { path: requestConfig.url });
        }
      },
      {
        retries: settings.maxRetries,
        baseDelayMs: settings.retryBaseMs,
        shouldRetry: isRetryable,
        onRetry: (err, attempt, delayMs) => {
          logger.warn(
            { courier_partner: COURIER, path: requestConfig.url, error_type: err.code, attempt, delayMs },
            'Retrying courier request after a transient failure',
          );
        },
      },
    );
  }

  /**
   * A 401 means the cached token was rejected — expired, or revoked on the courier's side.
   * Drop it and make exactly one more attempt. This deliberately sits outside withRetry so a
   * genuinely bad credential produces two auth calls, not an auth-request storm.
   */
  async function request(requestConfig) {
    try {
      return await send(requestConfig);
    } catch (err) {
      if (err.code !== ErrorCode.COURIER_AUTH_ERROR) throw err;

      logger.warn({ courier_partner: COURIER, path: requestConfig.url }, 'Courier token rejected, re-authenticating');
      cachedToken = null;
      return send(requestConfig);
    }
  }

  return { request };
}
