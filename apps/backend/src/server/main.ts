/**
 * Process entry point.
 *
 * Start order is part of the guarantee: the database must answer before the
 * port opens, so a request never reaches a server that has no data behind it.
 */
import { createServer } from 'node:http';
import { loadConfig } from '../config/config.js';
import { initCliEnvironment } from '../scripts/cli-env.js';
import { ensureIndexes } from '../infrastructure/schema.js';
import { createApp } from './app.js';
import { createContext } from './bootstrap.js';
import { listenWithExplanation } from './listen-errors.js';
import { startJobs, stopJobs } from '../jobs/scheduler.js';

async function main(): Promise<void> {
  initCliEnvironment();
  const config = loadConfig();
  const context = await createContext(config);
  await ensureIndexes(context.database.db);

  const { app } = createApp(config, context);
  const server = createServer(app);
  listenWithExplanation(server, config.PORT, config.HOST);

  server.listen(config.PORT, config.HOST, () => {
    context.logger.info(
      {
        host: config.HOST,
        port: config.PORT,
        basePath: config.API_BASE_PATH,
        cache: context.cache.enabled ? 'redis' : 'disabled',
        egressGuard: config.EGRESS_GUARD_ENABLED,
      },
      'tdt-backend listening',
    );
  });

  if (config.JOBS_ENABLED) {
    startJobs(config, context);
  }

  const shutdown = async (signal: string): Promise<void> => {
    context.logger.info({ signal }, 'shutting down');
    stopJobs();
    server.close();
    await context.cache.close();
    await context.database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Boot failures must be loud and must not keep the process alive.
  console.error(
    JSON.stringify({
      level: 'fatal',
      message: 'tdt-backend failed to start',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
