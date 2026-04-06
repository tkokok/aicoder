import type { FastifyInstance } from 'fastify';
import type { StartPipelineRequest } from '../shared/types.js';
import { executePipeline, stopPipeline } from './pipeline.js';
import { LocalFileSystem } from './filesystem.js';
import { createAgentRuntime } from './runtime/factory.js';
import { registerSession, getSession, unregisterSession } from './sessions.js';
import { notifySSEEvent } from './callback.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('data-routes');

export async function registerDataRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/pipeline/start', async (request, reply) => {
    const body = request.body as StartPipelineRequest;

    const {
      sessionId,
      playbook,
      workspaceDir,
      projectDir,
      mode,
      model,
      subagentModel,
      reasoningEffort,
    } = body;

    try {
      const runtime = await createAgentRuntime(projectDir);

      await runtime.prepareEnvironment(projectDir, {
        mainModel: model || 'zhipuai-coding-plan/glm-4.7-flashx',
        subagentModel: subagentModel || 'zhipuai-coding-plan/glm-4.7-flashx',
        reasoningEffort,
      });

      const session = await runtime.createSession({ title: sessionId });
      const dataPlaneSessionId = session.id;

      // Subscribe to runtime events and forward events to control plane
      const unsubscribeSSE = runtime.subscribeEvents((event) => {
        notifySSEEvent({ sessionId, event, timestamp: Date.now() }).catch(() => {});
      });

      const { stop } = await executePipeline({
        sessionId,
        dataPlaneSessionId,
        playbook,
        workspaceDir,
        projectDir,
        runtime,
        mode,
        model,
        reasoningEffort,
      });

      const cleanup = () => {
        stop();
        unsubscribeSSE();
        runtime.shutdown(projectDir);
        unregisterSession(sessionId);
      };

      registerSession({
        sessionId,
        dataPlaneSessionId,
        runtime,
        projectDir,
        stopPipeline: cleanup,
      });

      log.info(`Pipeline started`, { session_id: sessionId, data_plane_session_id: dataPlaneSessionId });

      return reply.status(201).send({
        pipelineId: sessionId,
        dataPlaneSessionId,
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

  fastify.post('/pipeline/:id/attach', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      dataPlaneSessionId: string;
      workspaceDir: string;
      projectDir: string;
    };
    const { dataPlaneSessionId, workspaceDir, projectDir } = body;
    const sessionId = id;

    if (getSession(sessionId)) {
      return reply.send({ attached: true, alreadyRunning: true });
    }

    try {
      const runtime = await createAgentRuntime(projectDir);

      const unsubscribeSSE = runtime.subscribeEvents((event) => {
        notifySSEEvent({ sessionId, event, timestamp: Date.now() }).catch(() => {});
      });

      const { stop } = await executePipeline({
        sessionId,
        dataPlaneSessionId,
        workspaceDir,
        projectDir,
        runtime,
        resume: true,
      });

      const cleanup = () => {
        stop();
        unsubscribeSSE();
        runtime.shutdown(projectDir);
        unregisterSession(sessionId);
      };

      registerSession({
        sessionId,
        dataPlaneSessionId,
        runtime,
        projectDir,
        stopPipeline: cleanup,
      });

      log.info(`Pipeline attached`, { session_id: sessionId, data_plane_session_id: dataPlaneSessionId });
      return reply.send({ attached: true, dataPlaneSessionId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Failed to attach pipeline', error, { session_id: sessionId });
      return reply.status(502).send({ attached: false, error: msg });
    }
  });

  fastify.get('/pipeline/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    return reply.send({ running: !!session });
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
      const messages = await session.runtime.getMessages(session.dataPlaneSessionId);
      return reply.send({ messages });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: msg });
    }
  });

  fastify.get('/models', async (_request, reply) => {
    try {
      const tempDir = process.env.TEMP_DIR || '/tmp/aicoder-models';
      const { mkdir } = await import('fs/promises');
      await mkdir(tempDir, { recursive: true });
      const runtime = await createAgentRuntime(tempDir);
      const models = await runtime.getModels();
      runtime.shutdown(tempDir);
      return reply.send({ models, default: 'zhipuai-coding-plan/glm-4.7-flashx' });
    } catch (error) {
      log.error('Failed to fetch models', error, { operation: 'fetch_models' });
      return reply.status(502).send({
        models: [],
        default: 'zhipuai-coding-plan/glm-4.7-flashx',
        error: 'Failed to fetch models from runtime',
      });
    }
  });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });
}
