import { app } from './app.js';
import { closeConnection, verifyConnection } from './db/knex.js';
import { config } from './config/index.js';
import { drainBatches } from './services/bulk.service.js';
import { loadCouriers } from './couriers/registry.js';
import { logger } from './utils/logger.js';

async function start() {
  // Fail fast: a service that cannot reach its database or load its adapters should refuse to
  // start rather than accept traffic it cannot serve.
  await verifyConnection();
  const couriers = await loadCouriers();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env, couriers }, 'Multi-courier platform listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close();
    // In-process batches are not durable across a restart, so at least give the ones already
    // running a chance to finish before the connection pool goes away.
    await drainBatches();
    await closeConnection();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
