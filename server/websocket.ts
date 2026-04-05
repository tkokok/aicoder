import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import fp from 'fastify-plugin';
import websocket, { WebSocket } from '@fastify/websocket';
import type { SSEEvent } from './opencode.js';
import { createComponentLogger } from './logger';

const log = createComponentLogger('websocket');

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
    log.info(`WebSocket client connected`, { operation: 'client_connect', total_clients: clients.size });

    socket.send(JSON.stringify({
      event: 'connected',
      data: { message: 'WebSocket connected', timestamp: Date.now() },
    }));

    socket.on('close', () => {
      clients.delete(socket);
      log.info(`WebSocket client disconnected`, { operation: 'client_disconnect', total_clients: clients.size });
    });

    socket.on('error', (error: Error) => {
      log.error('WebSocket client error', error, { operation: 'client_error' });
      clients.delete(socket);
    });

    socket.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') {
          log.debug(`Received ping, sending pong`, { operation: 'ping_pong' });
          socket.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
        }
      } catch {
        log.warn('Received malformed WebSocket message', { operation: 'malformed_message', data: data.toString().slice(0, 100) });
      }
    });
  });

  // Broadcast an SSE event to all connected WebSocket clients
  fastify.decorate('broadcastEvent', (event: SSEEvent) => {
    const payload = JSON.stringify({
      event: event.type || 'progress',
      data: event.properties || {},
    });

    let sentCount = 0;
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(payload);
        sentCount++;
      }
    }
    log.debug(`Broadcasted event to clients`, { operation: 'broadcast', event_type: event.type, client_count: sentCount });
  });

  fastify.addHook('preClose', async () => {
    log.info('Cleaning up WebSocket connections...', { operation: 'shutdown', client_count: clients.size });
    for (const client of clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore errors during shutdown
      }
    }
    clients.clear();
    log.info('WebSocket cleanup complete', { operation: 'shutdown_complete' });
  });
}

export default fp(websocketPlugin, {
  name: 'websocket-progress',
  fastify: '5.x',
});
