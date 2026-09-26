import { bool, num, required, str } from './env.js';

// Reading config at import time means a misconfigured service refuses to boot instead of
// failing on its first real request. server.js turns a throw here into a clean exit.
export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', str('NODE_ENV', 'development') === 'development'),

  apiKey: required('API_KEY'),
  databaseUrl: required('DATABASE_URL'),

  // Defaults every courier inherits unless it overrides them with its own env prefix.
  courier: {
    timeoutMs: num('COURIER_TIMEOUT_MS', 15000),
    maxRetries: num('COURIER_MAX_RETRIES', 2),
    retryBaseMs: num('COURIER_RETRY_BASE_MS', 500),
  },

  bulk: {
    maxOrders: num('BULK_MAX_ORDERS', 100),
    concurrency: num('BULK_CONCURRENCY', 10),
  },
};

export const isTest = config.env === 'test';
