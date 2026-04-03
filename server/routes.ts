import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from './db';
import { validateSessionInput, SessionInput } from './validation';
import { OpenCodeManager } from './opencode';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

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

/**
 * Validates and returns a trimmed string from unknown input.
 * Throws if value is not a string.
 */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

/**
 * Sanitizes project name for filesystem safety.
 * Removes or replaces characters that are unsafe for file/directory names.
 */
function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/**
 * Creates project directory structure at ~/.aicoder/projects/{project_name}/
 * Returns the project path.
 */
async function createProjectDirectory(projectName: string): Promise<string> {
  const sanitized = sanitizeProjectName(projectName);
  const baseDir = join(homedir(), '.aicoder', 'projects', sanitized);
  
  await mkdir(join(baseDir, '.opencode'), { recursive: true });
  await mkdir(join(baseDir, 'workspace'), { recursive: true });
  await mkdir(join(baseDir, 'logs'), { recursive: true });
  
  return baseDir;
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

      const projectName = requireString(input.projectName, 'projectName');
      request.log.info(`[routes] Creating session for project: ${projectName}`);

      let projectPath: string;

      try {
        projectPath = await createProjectDirectory(projectName);
        request.log.info(`[routes] Project directory created: ${projectPath}`);
      } catch (error) {
        request.log.error({ err: error }, '[routes] Failed to create project directory');
        return reply.status(500).send({
          error: 'Failed to create project directory',
        });
      }

      let opencodeSessionId: string;

      try {
        request.log.info(`[routes] Getting/creating OpenCode process for: ${projectPath}`);
        const { client, process: ocProcess } = await OpenCodeManager.getOrCreate(projectPath);
        request.log.info(`[routes] OpenCode process ready at ${ocProcess.url}`);

        request.log.info(`[routes] Creating OpenCode session with title: ${projectName}`);
        const opencodeSession = await client.createSession({
          title: projectName,
        });
        opencodeSessionId = opencodeSession.id;
        request.log.info(`[routes] OpenCode session created: ${opencodeSessionId}`);
      } catch (error) {
        request.log.error({ err: error }, '[routes] Failed to create OpenCode session');
        return reply.status(502).send({
          error: 'Failed to create session with OpenCode',
        });
      }

      const sessionId = generateId();
      request.log.info(`[routes] AICoder session created: ${sessionId} (opencode: ${opencodeSessionId})`);

      try {
        transaction(() => {
          db.prepare(
            `INSERT INTO sessions (id, opencode_session_id, project_path, status, created_at) 
             VALUES (?, ?, ?, 'pending', ?)`
          ).run(sessionId, opencodeSessionId, projectPath, Date.now());

          db.prepare(
            `INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            sessionId,
            projectName,
            requireString(input.requirements, 'requirements'),
            requireString(input.techStack, 'techStack'),
            input.devEnv ? requireString(input.devEnv, 'devEnv') : '',
            input.testMethod ? requireString(input.testMethod, 'testMethod') : ''
          );
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
