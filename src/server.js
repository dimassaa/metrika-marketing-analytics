import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeDb, pool } from './lib/db.js';

const app = createApp({ db: pool });

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, 'server listening');
});

let shuttingDown = false;

/**
 * Stops accepting connections, drains in-flight requests, closes the pool and lets the event loop end.
 * Repeated signals are ignored so a second Ctrl+C cannot interrupt a half-finished shutdown.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown started');

  try {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    logger.error({ err: error }, 'http server failed to close');
    process.exitCode = 1;
  }

  try {
    await closeDb();
    logger.info('shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'database pool failed to close');
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
