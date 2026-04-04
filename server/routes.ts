import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from './db';
import { validateSessionInput, SessionInput } from './validation';
import { OpenCodeManager, OpenCodeClient, type SSEEvent } from './opencode';
import { executePipeline } from './pipeline';
import { mkdir, cp, access, rm, stat, readFile, writeFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CreateSessionBody {
  projectName: unknown;
  requirements: unknown;
  techStack: unknown;
  devEnv?: unknown;
  testMethod?: unknown;
  model?: unknown;
  subagentModel?: unknown;
  mode?: unknown;
  existingPath?: unknown;
  opencodeUrl?: unknown;
  opencodeHeader?: unknown;
  opencodeUsername?: unknown;
  opencodePassword?: unknown;
}

interface SessionResponse {
  id: string;
  status: string;
  opencode_url?: string;
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
 * Returns the project path (managed directory for agents, schemas, and run outputs).
 */
async function createProjectDirectory(projectName: string): Promise<string> {
  const sanitized = sanitizeProjectName(projectName);
  const baseDir = join(homedir(), '.aicoder', 'projects', sanitized);

  await mkdir(join(baseDir, '.opencode'), { recursive: true });
  await mkdir(join(baseDir, '.opencode', 'agent'), { recursive: true });
  await mkdir(join(baseDir, 'workspace'), { recursive: true });
  await mkdir(join(baseDir, 'logs'), { recursive: true });

  // Copy agents and schemas so OpenCode can load them
  const agentsSrc = join(process.cwd(), 'agents');
  const agentsDest = join(baseDir, '.opencode', 'agent');
  const schemasSrc = join(process.cwd(), 'schemas');
  const schemasDest = join(baseDir, 'schemas');

  try {
    await cp(agentsSrc, agentsDest, { recursive: true, force: true });
  } catch {
    // ignore copy errors
  }

  try {
    await cp(schemasSrc, schemasDest, { recursive: true, force: true });
  } catch {
    // ignore copy errors
  }

  return baseDir;
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git init', { cwd: dir });
  } catch {
    // ignore errors
  }
}

async function injectAgentModel(agentPath: string, model: string): Promise<void> {
  const content = await readFile(agentPath, 'utf-8');
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);
  if (!match) {
    const newContent = `---\nmodel: ${model}\n---\n\n${content}`;
    await writeFile(agentPath, newContent, 'utf-8');
    return;
  }
  let frontmatter = match[1];
  if (/^model:/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^model:.*$/m, `model: ${model}`);
  } else {
    frontmatter = `model: ${model}\n${frontmatter}`;
  }
  const newContent = content.replace(frontmatterRegex, `---\n${frontmatter}\n---\n`);
  await writeFile(agentPath, newContent, 'utf-8');
}

async function getGitRepoName(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: dir });
    const url = stdout.trim();
    if (!url) return null;
    // Extract repo name from URL like git@host:owner/repo.git or https://host/owner/repo.git
    const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
    return basename(url, '.git') || null;
  } catch {
    return null;
  }
}

export async function registerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/sessions', async (_request, reply) => {
    const rows = db.prepare(`
      SELECT
        s.id,
        s.status,
        s.opencode_url,
        s.current_agent,
        s.created_at,
        s.completed_at,
        si.project_name,
        si.requirements,
        si.tech_stack
      FROM sessions s
      LEFT JOIN session_inputs si ON s.id = si.session_id
      ORDER BY s.created_at DESC
    `).all() as Array<{
      id: string;
      status: string;
      opencode_url?: string;
      current_agent?: string;
      created_at: number;
      completed_at?: number;
      project_name: string;
      requirements: string;
      tech_stack: string;
    }>;

    return reply.send(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        opencode_url: r.opencode_url || null,
        current_agent: r.current_agent || null,
        project_name: r.project_name,
        requirements: r.requirements,
        tech_stack: r.tech_stack,
        created_at: r.created_at,
        completed_at: r.completed_at || null,
      }))
    );
  });

  fastify.get('/api/models', async (_request, reply) => {
    try {
      const tempDir = join(homedir(), '.aicoder', '.temp-model-fetch');
      await mkdir(tempDir, { recursive: true });
      const { client } = await OpenCodeManager.getOrCreate(tempDir);
      const models = await client.getModels();
      return reply.send({ models, default: 'kimi-for-coding/k2p5' });
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to fetch models');
      return reply.status(502).send({
        models: [],
        default: 'kimi-for-coding/k2p5',
        error: 'Failed to fetch models from OpenCode',
      });
    }
  });

  fastify.post<{ Body: CreateSessionBody }>(
    '/api/sessions',
    async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply: FastifyReply) => {
      const input: SessionInput = {
        projectName: request.body.projectName,
        requirements: request.body.requirements,
        techStack: request.body.techStack,
        devEnv: request.body.devEnv,
        testMethod: request.body.testMethod,
        model: request.body.model,
        subagentModel: request.body.subagentModel,
        mode: request.body.mode,
        existingPath: request.body.existingPath,
        opencodeUrl: request.body.opencodeUrl,
        opencodeHeader: request.body.opencodeHeader,
        opencodeUsername: request.body.opencodeUsername,
        opencodePassword: request.body.opencodePassword,
      };

      const validation = validateSessionInput(input);
      if (!validation.valid) {
        return reply.status(400).send({
          error: 'Validation failed',
          errors: validation.errors,
        });
      }

      const projectName = requireString(input.projectName, 'projectName');
      const mode = typeof input.mode === 'string' && input.mode.trim() === 'existing' ? 'existing' : 'new';
      request.log.info(`[routes] Creating session for project: ${projectName} (mode=${mode})`);

      let projectDir: string;

      try {
        projectDir = await createProjectDirectory(projectName);
        request.log.info(`[routes] Project directory created: ${projectDir}`);
      } catch (error) {
        request.log.error({ err: error }, '[routes] Failed to create project directory');
        return reply.status(500).send({
          error: 'Failed to create project directory',
        });
      }

      const mainModel = input.model && typeof input.model === 'string' ? input.model : 'kimi-for-coding/k2p5';
      const subagentModel = input.subagentModel && typeof input.subagentModel === 'string' ? input.subagentModel : 'kimi-for-coding/k2p5';
      const agentsDest = join(projectDir, '.opencode', 'agent');
      try {
        await injectAgentModel(join(agentsDest, 'AICoder.md'), mainModel);
        for (const sub of ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate']) {
          await injectAgentModel(join(agentsDest, `${sub}.md`), subagentModel);
        }
        request.log.info(`[routes] Injected agent models: main=${mainModel}, sub=${subagentModel}`);
      } catch (err) {
        request.log.error({ err }, '[routes] Failed to inject agent models');
      }

      let workspaceDir: string;
      let repoName: string | null = null;
      if (mode === 'existing') {
        const existingPath = requireString(input.existingPath, 'existingPath');
        try {
          const s = await stat(existingPath);
          if (!s.isDirectory()) {
            return reply.status(400).send({ error: 'Existing project path is not a directory' });
          }
        } catch {
          return reply.status(400).send({ error: 'Existing project path does not exist or is not accessible' });
        }
        // Must be a git repository so we can create a worktree
        try {
          await execAsync('git rev-parse --git-dir', { cwd: existingPath });
        } catch {
          return reply.status(400).send({ error: 'Existing project path is not a git repository' });
        }
        workspaceDir = join(projectDir, 'workspace');
        // Remove the pre-created empty workspace directory so git worktree can create it
        try {
          await rm(workspaceDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        const branchName = `aicoder-${sanitizeProjectName(projectName)}`;
        try {
          await execAsync(`git worktree add "${workspaceDir}" -b ${branchName}`, { cwd: existingPath });
        } catch (err: any) {
          // If branch already exists, attach to it
          if (err?.stderr?.includes('already exists') || err?.message?.includes('already exists')) {
            try {
              await execAsync(`git worktree add "${workspaceDir}" ${branchName}`, { cwd: existingPath });
            } catch (err2: any) {
              request.log.error({ err: err2 }, '[routes] Failed to add git worktree with existing branch');
              return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
            }
          } else {
            request.log.error({ err }, '[routes] Failed to add git worktree');
            return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
          }
        }
        repoName = await getGitRepoName(existingPath);
        request.log.info(`[routes] Created worktree ${workspaceDir} from ${existingPath} (branch=${branchName}), repoName=${repoName}`);
      } else {
        workspaceDir = join(projectDir, 'workspace');
        await initGitRepo(workspaceDir);
      }

      let opencodeSessionId: string;
      let opencodeUrl: string;
      let client: OpenCodeClient;
      let isExternal = false;
      const extraHeaders: Record<string, string> = {};
      const auth = input.opencodeUsername && input.opencodePassword &&
        typeof input.opencodeUsername === 'string' && typeof input.opencodePassword === 'string'
        ? { username: input.opencodeUsername, password: input.opencodePassword }
        : undefined;

      if (input.opencodeHeader && typeof input.opencodeHeader === 'string' && input.opencodeHeader.trim()) {
        // Support "Key: Value" or "Key=Value" format, or simple string as header value
        const headerStr = input.opencodeHeader.trim();
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

      if (input.opencodeUrl && typeof input.opencodeUrl === 'string' && input.opencodeUrl.trim()) {
        isExternal = true;
        opencodeUrl = input.opencodeUrl.trim();
        try {
          const external = OpenCodeManager.getOrCreateExternal(projectDir, opencodeUrl, { extraHeaders, auth });
          client = external.client;
          request.log.info(`[routes] Using external OpenCode at ${opencodeUrl}`);
          const opencodeSession = await client.createSession({ title: projectName });
          opencodeSessionId = opencodeSession.id;
          request.log.info(`[routes] OpenCode session created on external server: ${opencodeSessionId}`);
        } catch (error) {
          request.log.error({ err: error }, '[routes] Failed to connect to external OpenCode');
          return reply.status(502).send({ error: 'Failed to connect to external OpenCode server' });
        }
      } else {
        try {
          request.log.info(`[routes] Getting/creating OpenCode process for: ${projectDir}`);
          const created = await OpenCodeManager.getOrCreate(projectDir);
          client = created.client;
          request.log.info(`[routes] OpenCode process ready at ${created.process.url}`);
          opencodeUrl = created.process.url;

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
      }

      const sessionId = generateId();
      request.log.info(`[routes] AICoder session created: ${sessionId} (opencode: ${opencodeSessionId})`);

      try {
        transaction(() => {
          db.prepare(
            `INSERT INTO sessions (id, opencode_session_id, project_path, workspace_path, repo_name, opencode_url, opencode_header, opencode_username, opencode_password, status, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).run(
            sessionId,
            opencodeSessionId,
            projectDir,
            workspaceDir,
            repoName || '',
            opencodeUrl,
            input.opencodeHeader && typeof input.opencodeHeader === 'string' ? input.opencodeHeader.trim() : '',
            input.opencodeUsername && typeof input.opencodeUsername === 'string' ? input.opencodeUsername.trim() : '',
            input.opencodePassword && typeof input.opencodePassword === 'string' ? input.opencodePassword : '',
            Date.now()
          );

          db.prepare(
            `INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method, model, subagent_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            sessionId,
            projectName,
            requireString(input.requirements, 'requirements'),
            requireString(input.techStack, 'techStack'),
            input.devEnv ? requireString(input.devEnv, 'devEnv') : '',
            input.testMethod ? requireString(input.testMethod, 'testMethod') : '',
            mainModel,
            subagentModel
          );
        });
      } catch (error) {
        request.log.error({ err: error }, 'Failed to create session in database');
        return reply.status(500).send({
          error: 'Failed to create session',
        });
      }

      const model = mainModel;
      const userInput = requireString(input.requirements, 'requirements');

      const unsubscribeSSE = client.subscribeEvents((event) => {
        try {
          (fastify as any).broadcastEvent(event);
        } catch {}
      });

      const stopProgressPolling = startProgressPolling(
        client,
        sessionId,
        opencodeSessionId,
        projectDir,
        (event) => {
          try {
            (fastify as any).broadcastEvent(event);
          } catch {}
        }
      );

      const maybeShutdownTempProcess = () => {
        if (!isExternal && OpenCodeManager.isManagedProcess(projectDir)) {
          request.log.info(`[routes] Shutting down temporary OpenCode process for ${sessionId}`);
          OpenCodeManager.shutdown(projectDir);
        }
      };

      executePipeline({
        sessionId,
        opencodeSessionId,
        userInput,
        workspaceDir,
        projectDir,
        client,
        model,
      }).then((result) => {
        request.log.info(`[routes] Pipeline completed for session ${sessionId}`);
        stopProgressPolling();
        maybeShutdownTempProcess();
        const reportMd = JSON.stringify(result, null, 2);
        transaction(() => {
          db.prepare(
            `UPDATE sessions SET status = 'completed', current_agent = 'completed', completed_at = ? WHERE id = ?`
          ).run(Date.now(), sessionId);
          db.prepare(
            `INSERT INTO session_reports (session_id, report_markdown, created_at) VALUES (?, ?, ?)`
          ).run(sessionId, reportMd, Date.now());
        });
        try {
          (fastify as any).broadcastEvent({
            type: 'completed',
            properties: { session_id: sessionId },
          });
        } catch {}
        unsubscribeSSE();
      }).catch((error) => {
        request.log.error({ err: error }, `[routes] Pipeline failed for session ${sessionId}`);
        stopProgressPolling();
        maybeShutdownTempProcess();
        transaction(() => {
          db.prepare(
            `UPDATE sessions SET status = 'failed', current_agent = 'failed', completed_at = ? WHERE id = ?`
          ).run(Date.now(), sessionId);
        });
        try {
          (fastify as any).broadcastEvent({
            type: 'failed',
            properties: { session_id: sessionId, error: error instanceof Error ? error.message : String(error) },
          });
        } catch {}
        unsubscribeSSE();
      });

      return reply.status(201).send({
        id: sessionId,
        status: 'pending',
        opencode_url: opencodeUrl,
      } as SessionResponse);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const session = db.prepare(
        'SELECT id, status, opencode_url, project_path, workspace_path, repo_name, current_agent, latest_message, stages_json, created_at, completed_at FROM sessions WHERE id = ?',
      ).get(id) as { id: string; status: string; opencode_url?: string; project_path?: string; workspace_path?: string; repo_name?: string; current_agent?: string; latest_message?: string; stages_json?: string; created_at: number; completed_at?: number } | undefined;

      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      let stagesObj: Record<string, unknown> | null = null;
      if (session.stages_json) {
        try {
          stagesObj = JSON.parse(session.stages_json) as Record<string, unknown>;
        } catch {}
      }

      return reply.send({
        ...session,
        stages: stagesObj,
      });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      const session = db.prepare(
        'SELECT id, project_path FROM sessions WHERE id = ?'
      ).get(id) as { id: string; project_path: string } | undefined;

      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      // Shut down associated OpenCode process first
      try {
        OpenCodeManager.shutdown(session.project_path);
      } catch {
        // ignore shutdown errors
      }

      transaction(() => {
        db.prepare('DELETE FROM session_reports WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM session_inputs WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      });

      // Clean up project directory
      try {
        await rm(session.project_path, { recursive: true, force: true });
      } catch (err) {
        request.log.warn({ err }, `Failed to remove project directory: ${session.project_path}`);
      }

      return reply.status(204).send();
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

const STAGE_ORDER = ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'];

function startProgressPolling(
  client: OpenCodeClient,
  sessionId: string,
  opencodeSessionId: string,
  projectDir: string,
  broadcast: (event: SSEEvent) => void
): () => void {
  let running = true;

  const poll = async () => {
    if (!running) return;
    try {
      // Infer current stage from disk files
      let completedStages = 0;
      for (const stage of STAGE_ORDER) {
        try {
          await access(join(projectDir, `run-${sessionId}`, `${stage}.json`));
          completedStages++;
        } catch {
          break;
        }
      }

      const currentStage = completedStages >= STAGE_ORDER.length ? 'completed' : STAGE_ORDER[completedStages];
      const progressPercent = Math.round((completedStages / STAGE_ORDER.length) * 100);
      const currentAgent = currentStage === 'completed' ? 'completed' : `${currentStage} agent`;

      // Get latest assistant message text (search backwards for non-empty content)
      let latestMessage = '';
      try {
        const messages = await client.getMessages(opencodeSessionId);
        const assistantMsgs = messages.filter((m) => m.role === 'assistant');
        for (let i = assistantMsgs.length - 1; i >= 0; i--) {
          const msg = assistantMsgs[i];
          if (msg?.parts) {
            const textParts = msg.parts
              .filter((p) => (p.type === 'text' || p.type === 'reasoning') && p.text)
              .map((p) => p.text as string);
            const joined = textParts.join('\n').trim();
            if (joined) {
              latestMessage = joined.slice(0, 800);
              break;
            }
          }
        }
      } catch {
        // ignore
      }

      // Build persisted stages snapshot from disk
      const stagesSnapshot: Record<string, { status: string }> = {};
      for (let i = 0; i < STAGE_ORDER.length; i++) {
        const stage = STAGE_ORDER[i];
        if (i < completedStages) {
          stagesSnapshot[stage] = { status: 'completed' };
        } else if (i === completedStages && currentStage !== 'completed') {
          stagesSnapshot[stage] = { status: 'running' };
        } else {
          stagesSnapshot[stage] = { status: 'pending' };
        }
      }
      const stagesJson = JSON.stringify(stagesSnapshot);

      // Update DB
      db.prepare(
        `UPDATE sessions SET current_agent = ?, latest_message = ?, stages_json = ? WHERE id = ?`
      ).run(currentAgent, latestMessage, stagesJson, sessionId);

      // Broadcast
      broadcast({
        type: 'progress',
        properties: {
          session_id: sessionId,
          current_stage: currentStage,
          current_agent: currentAgent,
          latest_message: latestMessage,
          progress_percent: progressPercent,
          stages: stagesSnapshot,
        },
      });
    } catch {
      // ignore polling errors
    }
  };

  const interval = setInterval(poll, 2500);
  poll();

  return () => {
    running = false;
    clearInterval(interval);
  };
}

export default registerRoutes;
