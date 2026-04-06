import Fastify from 'fastify';
import { registerControlRoutes } from './routes.js';
import { registerCallbackRoutes } from './callback-routes.js';
import websocketPlugin from './websocket.js';
import { db, closeDb } from '../db.js';
import { join } from 'path';
import logger from '../logger.js';
import { fileURLToPath } from 'url';
import { AgentClient, getAgentUrl } from './client/agent-client.js';

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

async function isOpenCodeSessionAlive(runtimeUrl: string, dataPlaneSessionId: string, projectDir: string): Promise<boolean> {
  try {
    const url = `${runtimeUrl.replace(/\/$/, '')}/session/${encodeURIComponent(dataPlaneSessionId)}`;
    const response = await fetch(url, {
      headers: { 'x-opencode-directory': projectDir },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

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

  await fastify.listen({ port, host });
  logger.info(`Control plane listening on ${host}:${port}`, { component: 'control-plane', operation: 'start' });

  // Reconnect check: verify whether previously running sessions are still active
  setTimeout(() => {
    (async () => {
      try {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const sessions = db.prepare(
          `SELECT
            s.id,
            s.agent_id,
            s.data_plane_session_id,
            s.project_path,
            s.workspace_path
          FROM sessions s
          WHERE s.status = ? AND s.created_at > ?`
        ).all('running', oneHourAgo) as Array<{
          id: string;
          agent_id?: string;
          data_plane_session_id?: string;
          project_path?: string;
          workspace_path?: string;
        }>;

        if (sessions.length === 0) return;

        logger.info(`Reconnect check for ${sessions.length} running session(s)`, { component: 'control-plane', operation: 'reconnect_check', count: sessions.length });

        for (const session of sessions) {
          let agentUrl = getAgentUrl();
          let runtimeLink: string | undefined;
          if (session.agent_id) {
            const agent = db.prepare('SELECT agent_url, runtime_link FROM agents WHERE id = ?').get(session.agent_id) as { agent_url: string; runtime_link?: string } | undefined;
            if (agent) {
              agentUrl = agent.agent_url;
              runtimeLink = agent.runtime_link || undefined;
            }
          }

          const client = new AgentClient(agentUrl);
          let agentRunning = false;
          try {
            const statusRes = await client.getPipelineStatus(session.id);
            agentRunning = statusRes.running;
          } catch {
            agentRunning = false;
          }

          if (agentRunning) {
            logger.info(`Session still tracked by agent`, { component: 'control-plane', operation: 'reconnect_check', session_id: session.id });
            continue;
          }

          // Agent lost tracking; check if OpenCode session is still alive
          const openCodeAlive = runtimeLink && session.data_plane_session_id && session.project_path
            ? await isOpenCodeSessionAlive(runtimeLink, session.data_plane_session_id, session.project_path)
            : false;

          if (openCodeAlive) {
            try {
              await client.attachPipeline({
                sessionId: session.id,
                dataPlaneSessionId: session.data_plane_session_id!,
                workspaceDir: session.workspace_path || session.project_path!,
                projectDir: session.project_path!,
              });
              logger.info(`Reattached pipeline to agent`, { component: 'control-plane', operation: 'reconnect_check', session_id: session.id });
            } catch (err) {
              db.prepare('UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?').run('failed', Date.now(), session.id);
              logger.warn(`Failed to reattach pipeline, marked as failed`, { component: 'control-plane', operation: 'reconnect_check', session_id: session.id, reason: err instanceof Error ? err.message : String(err) });
            }
          } else {
            db.prepare('UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?').run('failed', Date.now(), session.id);
            logger.info(`Marked session as failed (agent not running, OpenCode session gone)`, { component: 'control-plane', operation: 'reconnect_check', session_id: session.id });
          }
        }
      } catch (err) {
        logger.error('Failed to run reconnect check', err, { component: 'control-plane', operation: 'reconnect_check' });
      }
    })();
  }, 3000);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`, { component: 'control-plane', operation: 'shutdown', signal });
    try {
      await fastify.close();
      closeDb();
      logger.info('Control plane closed successfully', { component: 'control-plane', operation: 'shutdown' });
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', err, { component: 'control-plane', operation: 'shutdown' });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
