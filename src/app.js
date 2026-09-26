import express from 'express';
import pinoHttp from 'pino-http';

import { apiKeyAuth } from './middleware/api-key.js';
import { apiRoutes } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { db } from './db/knex.js';
import { logger } from './utils/logger.js';

export const app = express();

app.disable('x-powered-by');

// Before the body parser: a malformed JSON body fails inside express.json(), and that response
// still has to carry a request id for the consumer to quote.
app.use(requestId);

// A 100-order batch is comfortably larger than Express's 100kb default.
app.use(express.json({ limit: '5mb' }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => req.id,
    // Errors are logged with full context by the error handler; logging them again here would
    // double every failure in the log stream.
    autoLogging: { ignore: (req) => req.url === '/health' },
  }),
);

// Unauthenticated so an orchestrator can probe it without holding a credential.
app.get('/health', async (req, res) => {
  try {
    await db.raw('select 1');
    res.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unreachable', timestamp: new Date().toISOString() });
  }
});

app.use('/api/v1', apiKeyAuth, apiRoutes);

app.use(notFound);
app.use(errorHandler);
