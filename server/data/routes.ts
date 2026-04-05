import type { FastifyInstance } from 'fastify';
import type { StartPipelineRequest } from '../shared/types.js';
import { executePipeline, stopPipeline } from './pipeline.js';
import { LocalFileSystem } from './filesystem.js';
import { OpenCodeManager, type OpenCodeClientAuth } from './opencode.js';
import { registerSession, getSession, unregisterSession } from './sessions.js';
import { notifySSEEvent } from './callback.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('data-routes');

export async function registerDataRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/pipeline/start', async (request, reply) => {
    const body = request.body as StartPipelineRequest & {
      opencodeEnv?: 'random' | 'external';
      opencodeUrl?: string;
      opencodeHeader?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
    };

    const {
      sessionId,
      playbook,
      workspaceDir,
      projectDir,
      mode,
      model,
      reasoningEffort,
    } = body;

    const opencodeEnv = body.opencodeEnv || 'external';
    const extraHeaders: Record<string, string> = {};
    if (body.opencodeHeader && body.opencodeHeader.trim()) {
      const headerStr = body.opencodeHeader.trim();
      const colonIdx = headerStr.indexOf(':');
      const eqIdx = headerStr.indexOf('=');
      if (colonIdx > 0) {
        extraHeaders[headerStr.slice(0, colonIdx).trim()] = headerStr.slice(colonIdx + 1).trim();
      } else if (eqIdx > 0) {
        extraHeaders[headerStr.slice(0, eqIdx).trim()] = headerStr.slice(eqIdx + 1).trim();
      } else {
        extraHeaders['x-custom-header'] = headerStr;
      }
    }

    const auth = body.opencodeUsername && body.opencodePassword
      ? { username: body.opencodeUsername, password: body.opencodePassword }
      : undefined;

    try {
      let client: import('./opencode.js').OpenCodeClient;
      let opencodeUrl: string;

      if (opencodeEnv === 'random') {
        const created = await OpenCodeManager.getOrCreate(projectDir);
        client = created.client;
        opencodeUrl = created.process.url;
      } else {
        opencodeUrl = body.opencodeUrl?.trim() || 'http://127.0.0.1:4096';
        const created = OpenCodeManager.getOrCreateExternal(projectDir, opencodeUrl, { extraHeaders, auth });
        client = created.client;
      }

      const opencodeSession = await client.createSession({ title: sessionId });
      const opencodeSessionId = opencodeSession.id;

      // Subscribe to OpenCode SSE and forward events to control plane
      const unsubscribeSSE = client.subscribeEvents((event) => {
        notifySSEEvent({ sessionId, event, timestamp: Date.now() }).catch(() => {});
      });

      const { stop } = await executePipeline({
        sessionId,
        opencodeSessionId,
        playbook,
        workspaceDir,
        projectDir,
        client,
        mode,
        model,
        reasoningEffort,
      });

      const cleanup = () => {
        stop();
        unsubscribeSSE();
        if (opencodeEnv === 'random' && OpenCodeManager.isManagedProcess(projectDir)) {
          OpenCodeManager.shutdown(projectDir);
        }
        unregisterSession(sessionId);
      };

      registerSession({
        sessionId,
        opencodeSessionId,
        client,
        projectDir,
        stopPipeline: cleanup,
      });

      log.info(`Pipeline started`, { session_id: sessionId, opencode_session_id: opencodeSessionId });

      return reply.status(201).send({
        pipelineId: sessionId,
        opencodeSessionId,
        opencodeUrl,
        status: 'started',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Failed to start pipeline', error, { session_id: sessionId });
      return reply.status(502).send({
        pipelineId: sessionId,
        status: 'failed',
        error: msg,
      });
    }
  });

  fastify.post('/pipeline/:id/stop', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session) {
      session.stopPipeline();
      unregisterSession(id);
      log.info(`Pipeline stopped`, { session_id: id });
    } else {
      stopPipeline(id);
    }
    return reply.send({ ok: true });
  });

  fastify.get('/output/:stage', async (request, reply) => {
    const { stage } = request.params as { stage: string };
    const sessionId = (request.query as Record<string, string>).sessionId;
    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId is required' });
    }
    const session = getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found on agent' });
    }
    const fs = new LocalFileSystem(session.projectDir);
    const data = await fs.readStageOutput(sessionId, stage);
    if (!data) {
      return reply.status(404).send({ error: 'Stage output not found' });
    }
    return reply.send({
      status: (data.status as string) || 'completed',
      output: data,
      timestamp: Date.now(),
    });
  });

  fastify.get('/messages', async (request, reply) => {
    const sessionId = (request.query as Record<string, string>).sessionId;
    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId is required' });
    }
    const session = getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found on agent' });
    }
    try {
      const messages = await session.client.getMessages(session.opencodeSessionId);
      return reply.send({ messages });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: msg });
    }
  });

  fastify.get('/models', async (_request, reply) => {
    try {
      // Use a temporary project dir for model fetching
      const tempDir = process.env.TEMP_DIR || '/tmp/aicoder-models';
      const { mkdir } = await import('fs/promises');
      await mkdir(tempDir, { recursive: true });
      const defaultUrl = process.env.AGENT_OPENCODE_URL || 'http://127.0.0.1:4096';
      const { client } = OpenCodeManager.getOrCreateExternal(tempDir, defaultUrl);
      const models = await client.getModels();
      return reply.send({ models, default: 'zhipuai-coding-plan/glm-4.7-flashx' });
    } catch (error) {
      log.error('Failed to fetch models', error, { operation: 'fetch_models' });
      return reply.status(502).send({
        models: [],
        default: 'zhipuai-coding-plan/glm-4.7-flashx',
        error: 'Failed to fetch models from OpenCode',
      });
    }
  });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });
}
