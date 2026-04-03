import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from './db';
import { validateSessionInput, SessionInput } from './validation';
import { createOpenCodeClient } from './opencode';
import { mkdir } from 'fs/promises';
import { join } from 'path';

interface CreateSessionBody {
  projectName: unknown;
  requirements: unknown;
  techStack: unknown;
  devEnv?: unknown;
  testMethod?: unknown;
}

interface SessionResponse {
  id: string;
  status: string;
}

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateSessionBody }>(
    '/api/sessions',
    async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply: FastifyReply) => {
      const input: SessionInput = {
        projectName: request.body.projectName,
        requirements: request.body.requirements,
        techStack: request.body.techStack,
        devEnv: request.body.devEnv,
        testMethod: request.body.testMethod,
      };

      const validation = validateSessionInput(input);
      if (!validation.valid) {
        return reply.status(400).send({
          error: 'Validation failed',
          errors: validation.errors,
        });
      }

      const opencodeClient = createOpenCodeClient();
      let opencodeSessionId: string;

      try {
        const opencodeSession = await opencodeClient.createSession();
        opencodeSessionId = opencodeSession.data.id;
      } catch (error) {
        request.log.error({ err: error }, 'Failed to create OpenCode session');
        return reply.status(502).send({
          error: 'Failed to create session with OpenCode',
        });
      }

      const sessionId = generateId();

      try {
        transaction(() => {
          db.prepare(
            `INSERT INTO sessions (id, opencode_session_id, status, created_at) 
             VALUES (?, ?, 'pending', ?)`
          ).run(sessionId, opencodeSessionId, Date.now());

          db.prepare(
            `INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            sessionId,
            (input.projectName as string).trim(),
            (input.requirements as string).trim(),
            (input.techStack as string).trim(),
            input.devEnv ? (input.devEnv as string).trim() : '',
            input.testMethod ? (input.testMethod as string).trim() : ''
          );

          const workspaceDir = join(process.cwd(), 'workspaces', sessionId);
          mkdir(workspaceDir, { recursive: true }).catch((err) => {
            request.log.error({ err }, 'Failed to create workspace directory');
          });
        });
      } catch (error) {
        request.log.error({ err: error }, 'Failed to create session in database');
        return reply.status(500).send({
          error: 'Failed to create session',
        });
      }

      return reply.status(201).send({
        id: sessionId,
        status: 'pending',
      } as SessionResponse);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id/report',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const session = db.prepare(
        'SELECT id, status FROM sessions WHERE id = ?',
      ).get(id) as { id: string; status: string } | undefined;

      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
        });
      }

      if (session.status === 'completed') {
        const report = db.prepare(
          'SELECT report_markdown FROM session_reports WHERE session_id = ?',
        ).get(id) as { report_markdown: string } | undefined;

        if (!report) {
          return reply.status(404).send({
            error: 'Report not found for completed session',
          });
        }

        return reply.send({
          markdown: report.report_markdown,
        });
      }

      return reply.send({
        status: session.status,
      });
    }
  );
}

export default registerRoutes;
