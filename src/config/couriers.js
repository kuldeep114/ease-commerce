import { config } from './index.js';
import { bool, num, str } from './env.js';

/**
 * Courier settings are resolved by convention from `<COURIER_NAME>_*` environment variables.
 *
 * This is deliberate: onboarding a courier must not require editing shared code, and that
 * includes this file. A new adapter named "delhivery" picks up DELHIVERY_BASE_URL,
 * DELHIVERY_ENABLED and friends with no change here.
 *
 * @param {string} name adapter name, e.g. "urbanebolt"
 */
export function courierConfig(name) {
  const prefix = name.toUpperCase();
  const scoped = (suffix, fallback) => str(`${prefix}_${suffix}`, fallback);

  return {
    name,
    enabled: bool(`${prefix}_ENABLED`, false),
    baseUrl: scoped('BASE_URL'),
    username: scoped('USERNAME'),
    password: scoped('PASSWORD'),
    timeoutMs: num(`${prefix}_TIMEOUT_MS`, config.courier.timeoutMs),
    maxRetries: num(`${prefix}_MAX_RETRIES`, config.courier.maxRetries),
    retryBaseMs: num(`${prefix}_RETRY_BASE_MS`, config.courier.retryBaseMs),

    // Escape hatch for settings only one courier has, e.g. UrbaneBolt's customerCode.
    get: scoped,
    getNumber: (suffix, fallback) => num(`${prefix}_${suffix}`, fallback),
    getBoolean: (suffix, fallback) => bool(`${prefix}_${suffix}`, fallback),
  };
}
