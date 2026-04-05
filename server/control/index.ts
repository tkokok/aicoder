import Fastify from 'fastify';
import { registerControlRoutes } from './routes.js';
import { registerCallbackRoutes } from './callback-routes.js';
import websocketPlugin from './websocket.js';
import { db, closeDb } from '../db.js';
import { join } from 'path';
import logger from '../logger.js';
import { fileURLToPath } from 'url';

const fastify = Fastify({
  logger: { level: 'info' },
});

fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  logger.error('Request error', error, { component: 'control-plane', operation: 'request_error', path: request.url, method: request.method });
  reply.status(error.statusCode || 500).send({ error: error.message || 'Internal Server Error' });
});

fastify.setNotFoundHandler((request, reply) => {
  reply.status(404).send({ error: 'Not Found' });
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export async function startControlPlane(opts?: { port?: number }): Promise<void> {
  await fastify.register(import('@fastify/static'), {
    root: join(__dirname, '../../frontend'),
    prefix: '/',
  });

  await fastify.register(websocketPlugin);
  await fastify.register(registerCallbackRoutes);
  await fastify.register(registerControlRoutes);

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  const port = opts?.port || parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10);
  const host = process.env.CONTROL_PLANE_HOST || '0.0.0.0';

  // Mark any previously running sessions as failed
  try {
    const now = Date.now();
    const result = db.prepare("UPDATE sessions SET status = 'failed', completed_at = ? WHERE status = 'running'").run(now);
    if (result.changes > 0) {
      logger.info(`Marked ${result.changes} orphaned running session(s) as failed`, { component: 'control-plane', operation: 'cleanup' });
    }
  } catch (err) {
    logger.error('Failed to clean up orphaned sessions', err, { component: 'control-plane', operation: 'cleanup' });
  }

  await fastify.listen({ port, host });
  logger.info(`Control plane listening on ${host}:${port}`, { component: 'control-plane' });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`, { component: 'control-plane', signal });
    try {
      await fastify.close();
      closeDb();
      logger.info('Control plane closed successfully', { component: 'control-plane' });
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', err, { component: 'control-plane' });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
