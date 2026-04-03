import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import fp from 'fastify-plugin';
import websocket, { WebSocket } from '@fastify/websocket';
import type { SSEEvent } from './opencode.js';

export interface WebSocketMessage {
  event: string;
  data: Record<string, unknown>;
}

export interface WebSocketHandlerOptions extends FastifyPluginOptions {}

async function websocketPlugin(
  fastify: FastifyInstance,
  _options: WebSocketHandlerOptions
): Promise<void> {
  const clients = new Set<WebSocket>();

  await fastify.register(websocket);

  fastify.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    fastify.log.info(`WebSocket client connected. Total clients: ${clients.size}`);

    socket.send(JSON.stringify({
      event: 'connected',
      data: { message: 'WebSocket connected', timestamp: Date.now() },
    }));

    socket.on('close', () => {
      clients.delete(socket);
      fastify.log.info(`WebSocket client disconnected. Total clients: ${clients.size}`);
    });

    socket.on('error', (error: Error) => {
      fastify.log.error({ err: error }, 'WebSocket client error');
      clients.delete(socket);
    });

    socket.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') {
          socket.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
        }
      } catch {
        // Ignore malformed messages
      }
    });
  });

  // Broadcast an SSE event to all connected WebSocket clients
  fastify.decorate('broadcastEvent', (event: SSEEvent) => {
    const payload = JSON.stringify({
      event: event.type || 'progress',
      data: event.properties || {},
    });

    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  });

  fastify.addHook('preClose', async () => {
    fastify.log.info('Cleaning up WebSocket connections...');
    for (const client of clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore errors during shutdown
      }
    }
    clients.clear();
    fastify.log.info('WebSocket cleanup complete');
  });
}

export default fp(websocketPlugin, {
  name: 'websocket-progress',
  fastify: '5.x',
});
