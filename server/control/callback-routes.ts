import type { FastifyInstance } from 'fastify';
import type {
  StageCompleteCallback,
  PipelineCompleteCallback,
  PipelineStatusUpdateCallback,
  SSEForwardCallback,
} from '../shared/types.js';
import { db, transaction } from '../db.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('callback-routes');

const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;

export async function registerCallbackRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/internal/')) {
      const token = request.headers.authorization?.replace('Bearer ', '');
      if (CALLBACK_TOKEN && token !== CALLBACK_TOKEN) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }
  });

  fastify.post('/api/internal/stage-complete', async (request, reply) => {
    const event = request.body as StageCompleteCallback;
    log.info(`Stage complete callback`, { session_id: event.sessionId, stage: event.stage, status: event.status });

    try {
      // Update stages_json and current_agent
      const row = db.prepare('SELECT stages_json FROM sessions WHERE id = ?').get(event.sessionId) as { stages_json?: string } | undefined;
      let stages: Record<string, { status: string }> = {};
      if (row?.stages_json) {
        try {
          stages = JSON.parse(row.stages_json);
        } catch {}
      }
      stages[event.stage] = { status: event.status };
      const stagesJson = JSON.stringify(stages);
      const currentAgent = event.stage;

      db.prepare('UPDATE sessions SET current_agent = ?, stages_json = ? WHERE id = ?')
        .run(currentAgent, stagesJson, event.sessionId);

      (fastify as any).broadcastEvent?.({
        type: 'stage_complete',
        properties: {
          session_id: event.sessionId,
          stage: event.stage,
          status: event.status,
          stages,
        },
      });

      return reply.send({ ok: true });
    } catch (error) {
      log.error('Failed to process stage-complete callback', error, { session_id: event.sessionId });
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  fastify.post('/api/internal/pipeline-complete', async (request, reply) => {
    const event = request.body as PipelineCompleteCallback;
    log.info(`Pipeline complete callback`, { session_id: event.sessionId, status: event.status, error: event.error });

    try {
      const now = Date.now();
      transaction(() => {
        db.prepare(
          `UPDATE sessions SET status = ?, current_agent = 'completed', completed_at = ? WHERE id = ?`
        ).run(event.status, now, event.sessionId);

        if (event.status === 'completed') {
          const reportMd = JSON.stringify(event, null, 2);
          db.prepare(
            `INSERT OR REPLACE INTO session_reports (session_id, report_markdown, created_at) VALUES (?, ?, ?)`
          ).run(event.sessionId, reportMd, now);
        }
      });

      (fastify as any).broadcastEvent?.({
        type: event.status,
        properties: {
          session_id: event.sessionId,
          error: event.error,
        },
      });

      return reply.send({ ok: true });
    } catch (error) {
      log.error('Failed to process pipeline-complete callback', error, { session_id: event.sessionId });
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  fastify.post('/api/internal/pipeline-status', async (request, reply) => {
    const event = request.body as PipelineStatusUpdateCallback;
    try {
      const stagesJson = JSON.stringify(event.stages);
      db.prepare(
        `UPDATE sessions SET current_agent = ?, stages_json = ? WHERE id = ?`
      ).run(event.currentStage, stagesJson, event.sessionId);

      (fastify as any).broadcastEvent?.({
        type: 'progress',
        properties: {
          session_id: event.sessionId,
          current_stage: event.currentStage,
          overall_status: event.overallStatus,
          stages: event.stages,
        },
      });

      return reply.send({ ok: true });
    } catch (error) {
      log.error('Failed to process pipeline-status callback', error, { session_id: event.sessionId });
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  fastify.post('/api/internal/sse-event', async (request, reply) => {
    const event = request.body as SSEForwardCallback;
    try {
      (fastify as any).broadcastEvent?.(event.event);
      return reply.send({ ok: true });
    } catch (error) {
      log.error('Failed to process sse-event callback', error, { session_id: event.sessionId });
      return reply.status(500).send({ error: 'Internal error' });
    }
  });
}
