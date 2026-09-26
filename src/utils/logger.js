import pino from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  // Courier credentials and bearer tokens travel through the same objects we log for audit,
  // so they are stripped centrally rather than at each call site.
  redact: {
    paths: [
      'password',
      '*.password',
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'access_token',
      '*.access_token',
      'config.headers.Authorization',
    ],
    censor: '[REDACTED]',
  },
  ...(config.logPretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});
