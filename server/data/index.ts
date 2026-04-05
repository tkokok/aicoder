import Fastify from 'fastify';
import { registerDataRoutes } from './routes.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('data-plane');

export async function startDataPlane(opts?: { port?: number }): Promise<void> {
  const fastify = Fastify({
    logger: false, // use our own logger
  });

  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    log.error('Data plane request error', error, { path: request.url, method: request.method });
    reply.status(error.statusCode || 500).send({
      error: error.message || 'Internal Server Error',
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: 'Not Found' });
  });

  fastify.addHook('onRequest', async (request) => {
    log.debug(`→ ${request.method} ${request.url}`, { method: request.method, url: request.url });
  });
  fastify.addHook('onResponse', async (request, reply) => {
    log.debug(`← ${reply.statusCode} ${request.method} ${request.url}`, { method: request.method, url: request.url, status: reply.statusCode });
  });

  await fastify.register(registerDataRoutes);

  const port = opts?.port || parseInt(process.env.AGENT_PORT || '8443', 10);
  const host = process.env.AGENT_HOST || '0.0.0.0';

  await fastify.listen({ port, host });
  log.info(`Data plane listening on ${host}:${port}`, { port, host });

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down data plane...`, { signal });
    try {
      await fastify.close();
      log.info('Data plane closed', {});
      process.exit(0);
    } catch (err) {
      log.error('Error during data plane shutdown', err, {});
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
