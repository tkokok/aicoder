// Bypass HTTP proxy for localhost connections to prevent 503 errors from local proxies (e.g. v2ray)
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
process.env.no_proxy = 'localhost,127.0.0.1,::1';

import Fastify from 'fastify';
import { registerRoutes } from './routes';
import websocketPlugin from './websocket';
import { OpenCodeManager } from './opencode';
import { db, closeDb } from './db';
import { join } from 'path';
import logger from './logger';
import { fileURLToPath } from 'url';

const fastify = Fastify({
  logger: {
    level: 'info',
  },
});

fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  logger.error('Request error', error, { component: 'server', operation: 'request_error', path: request.url, method: request.method });
  reply.status(error.statusCode || 500).send({
    error: error.message || 'Internal Server Error',
  });
});

fastify.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    error: 'Not Found',
  });
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function start() {
  try {
    await fastify.register(import('@fastify/static'), {
      root: join(__dirname, '../frontend'),
      prefix: '/',
    });

    await fastify.register(websocketPlugin);

    await fastify.register(registerRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok', timestamp: Date.now() };
    });

    const port = parseInt(process.env.PORT || '8080', 10);
    const host = process.env.HOST || '0.0.0.0';

    // Mark any previously running sessions as failed (they were orphaned by a restart)
    try {
      const now = Date.now();
      const result = db.prepare(
        "UPDATE sessions SET status = 'failed', completed_at = ? WHERE status = 'running'"
      ).run(now);
      if (result.changes > 0) {
        logger.info(`Marked ${result.changes} orphaned running session(s) as failed`, { component: 'server', operation: 'cleanup' });
      }
    } catch (err) {
      logger.error('Failed to clean up orphaned sessions', err, { component: 'server', operation: 'cleanup' });
    }

    await fastify.listen({ port, host });
    logger.info(`Server listening on ${host}:${port}`, { component: 'server' });

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown...`, { component: 'server' });
      OpenCodeManager.shutdownAll();
      try {
        await fastify.close();
        closeDb();
        logger.info('Server closed successfully', { component: 'server' });
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', err, { component: 'server' });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error('Error starting server', err, { component: 'server' });
    process.exit(1);
  }
}

start();
