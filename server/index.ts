import Fastify from 'fastify';
import { registerRoutes } from './routes';
import websocketPlugin from './websocket';
import { createOpenCodeClient } from './opencode';

const fastify = Fastify({
  logger: {
    level: 'info',
  },
});

const opencodeClient = createOpenCodeClient();

fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  fastify.log.error({ err: error }, 'Request error');
  reply.status(error.statusCode || 500).send({
    error: error.message || 'Internal Server Error',
  });
});

fastify.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    error: 'Not Found',
  });
});

async function start() {
  try {
    await fastify.register(websocketPlugin, {
      opencodeClient,
    });

    await fastify.register(registerRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok', timestamp: Date.now() };
    });

    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on ${host}:${port}`);

    const shutdown = async (signal: string) => {
      fastify.log.info(`Received ${signal}, starting graceful shutdown...`);
      try {
        await fastify.close();
        fastify.log.info('Server closed successfully');
        process.exit(0);
      } catch (err) {
        fastify.log.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    fastify.log.error({ err }, 'Error starting server');
    process.exit(1);
  }
}

start();
