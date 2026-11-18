/**
 * Burrow server entry point: load config, open the database, start the HTTP
 * server, then cloudflared and the background jobs. Shuts down gracefully on
 * SIGTERM / SIGINT (Docker stop, Ctrl+C).
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { createLogger } from './lib/logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const ctx = createContext(config, logger);
  const app = await buildApp(ctx);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, exiting');
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await ctx.lifecycle.stop();
      await app.close();
      ctx.sqlite.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { version: ctx.version, port: config.port, dataDir: config.dataDir },
    'Burrow is listening',
  );
  await ctx.lifecycle.start();
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
