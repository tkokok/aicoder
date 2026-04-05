// Bypass HTTP proxy for localhost connections
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
process.env.no_proxy = 'localhost,127.0.0.1,::1';

import { startControlPlane } from './control/index.js';
import { startDataPlane } from './data/index.js';
import logger from './logger.js';

const USE_DATA_PLANE = process.env.USE_DATA_PLANE !== 'false';

async function startLegacyServer(): Promise<void> {
  // Import legacy modules inline to avoid loading them when not needed
  const { default: Fastify } = await import('fastify');
  const { registerRoutes } = await import('./routes.js');
  const { default: websocketPlugin } = await import('./websocket.js');
  const { OpenCodeManager } = await import('./opencode.js');
  const { db, closeDb } = await import('./db.js');
  const { join } = await import('path');
  const { fileURLToPath } = await import('url');

  const fastify = Fastify({ logger: { level: 'info' } });

  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    logger.error('Request error', error, { component: 'server', operation: 'request_error', path: request.url, method: request.method });
    reply.status(error.statusCode || 500).send({ error: error.message || 'Internal Server Error' });
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: 'Not Found' });
  });

  const __dirname = fileURLToPath(new URL('.', import.meta.url));

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

  try {
    const now = Date.now();
    const result = db.prepare("UPDATE sessions SET status = 'failed', completed_at = ? WHERE status = 'running'").run(now);
    if (result.changes > 0) {
      logger.info(`Marked ${result.changes} orphaned running session(s) as failed`, { component: 'server', operation: 'cleanup' });
    }
  } catch (err) {
    logger.error('Failed to clean up orphaned sessions', err, { component: 'server', operation: 'cleanup' });
  }

  await fastify.listen({ port, host });
  logger.info(`Legacy server listening on ${host}:${port}`, { component: 'server' });

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
}

async function main() {
  if (USE_DATA_PLANE) {
    logger.info('Starting in data-plane mode', { component: 'main', use_data_plane: true, mode: process.env.MODE || 'local' });
    await startControlPlane({ port: parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10) });

    if (process.env.MODE === 'local') {
      const agentPort = parseInt(process.env.AGENT_PORT || '8443', 10);
      process.env.DEFAULT_AGENT_URL = `http://localhost:${agentPort}`;
      await startDataPlane({ port: agentPort });
    }
  } else {
    logger.info('Starting in legacy mode', { component: 'main', use_data_plane: false });
    await startLegacyServer();
  }
}

main().catch((err) => {
  logger.error('Fatal error during startup', err, { component: 'main' });
  process.exit(1);
});
