import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from './db';
import { validateSessionInput, SessionInput } from './validation';
import { OpenCodeManager, OpenCodeClient, type SSEEvent } from './opencode';
import { executePipeline, readStatusFile, STAGE_ORDER, getStageOrder, type PipelineMode } from './pipeline';
import { mkdir, cp, access, rm, stat, readFile, writeFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger, createSessionLogger } from './logger';

const execAsync = promisify(exec);

import type { ModelInfo } from './opencode';

let modelsCache: {
  models: ModelInfo[];
  default: string;
  fetchedAt: number;
} | null = null;

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CreateSessionBody {
  projectName: unknown;
  requirements: unknown;
  techStack?: unknown;
  devEnv?: unknown;
  testMethod?: unknown;
  model?: unknown;
  subagentModel?: unknown;
  mode?: unknown;
  pipelineMode?: unknown;
  existingPath?: unknown;
  opencodeEnv?: unknown;
  opencodeUrl?: unknown;
  opencodeHeader?: unknown;
  opencodeUsername?: unknown;
  opencodePassword?: unknown;
  reasoningEffort?: unknown;
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
  } catch (error) {
    logger.warn('Failed to copy agents directory, continuing...', { component: 'routes', operation: 'copy_agents', error: error instanceof Error ? error.message : String(error) });
    // Continue - agents may already exist or be created later
  }

  try {
    await cp(schemasSrc, schemasDest, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to copy schemas directory, continuing...', { component: 'routes', operation: 'copy_schemas', error: error instanceof Error ? error.message : String(error) });
    // Continue - schemas may already exist or be created later
  }

  return baseDir;
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git init', { cwd: dir });
  } catch (error) {
    logger.warn('Failed to initialize git repo, continuing...', { component: 'routes', operation: 'git_init', error: error instanceof Error ? error.message : String(error) });
    // Continue - git is optional for new projects
  }
}

async function injectAgentFrontmatter(agentPath: string, model: string, reasoningEffort?: string): Promise<void> {
  const content = await readFile(agentPath, 'utf-8');
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);
  let frontmatter = match ? match[1] : '';
  if (/^model:/m.test(frontmatter)) {
    frontmatter = frontmatter.replace(/^model:.*$/m, `model: ${model}`);
  } else {
    frontmatter = `model: ${model}\n${frontmatter}`;
  }
  if (reasoningEffort) {
    if (/^reasoning_effort:/m.test(frontmatter)) {
      frontmatter = frontmatter.replace(/^reasoning_effort:.*$/m, `reasoning_effort: ${reasoningEffort}`);
    } else {
      frontmatter = `reasoning_effort: ${reasoningEffort}\n${frontmatter}`;
    }
  }
  if (!match) {
    const newContent = `---\n${frontmatter}\n---\n\n${content}`;
    await writeFile(agentPath, newContent, 'utf-8');
    return;
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
    const now = Date.now();
    if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
      return reply.send({ models: modelsCache.models, default: modelsCache.default });
    }

    const tempDir = join(homedir(), '.aicoder', '.temp-model-fetch');
    try {
      await mkdir(tempDir, { recursive: true });
      const { client } = await OpenCodeManager.getOrCreate(tempDir);
      const models = await client.getModels();
      modelsCache = { models, default: 'zhipuai-coding-plan/glm-4.7-flashx', fetchedAt: Date.now() };
      return reply.send({ models, default: modelsCache.default });
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to fetch models');
      return reply.status(502).send({
        models: [],
        default: 'zhipuai-coding-plan/glm-4.7-flashx',
        error: 'Failed to fetch models from OpenCode',
      });
    } finally {
      if (OpenCodeManager.isManagedProcess(tempDir)) {
        OpenCodeManager.shutdown(tempDir);
      }
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
        pipelineMode: request.body.pipelineMode,
        existingPath: request.body.existingPath,
        opencodeEnv: request.body.opencodeEnv,
        opencodeUrl: request.body.opencodeUrl,
        opencodeHeader: request.body.opencodeHeader,
        opencodeUsername: request.body.opencodeUsername,
        opencodePassword: request.body.opencodePassword,
        reasoningEffort: request.body.reasoningEffort,
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
      logger.info(`Creating session for project: ${projectName}`, { component: 'routes', operation: 'create_session', project_name: projectName, mode });

      let projectDir: string;

      try {
        projectDir = await createProjectDirectory(projectName);
        logger.info(`Project directory created: ${projectDir}`, { component: 'routes', operation: 'create_project_dir', project_name: projectName });
      } catch (error) {
        logger.error('Failed to create project directory', error, { component: 'routes', operation: 'create_project_dir', project_name: projectName });
        return reply.status(500).send({
          error: 'Failed to create project directory',
        });
      }

      const mainModel = input.model && typeof input.model === 'string' ? input.model : 'zhipuai-coding-plan/glm-4.7-flashx';
      const subagentModel = input.subagentModel && typeof input.subagentModel === 'string' ? input.subagentModel : 'zhipuai-coding-plan/glm-4.7-flashx';
      const reasoningEffort = input.reasoningEffort && typeof input.reasoningEffort === 'string' ? input.reasoningEffort : 'low';
      const agentsDest = join(projectDir, '.opencode', 'agent');
      try {
        await injectAgentFrontmatter(join(agentsDest, 'AICoder.md'), mainModel, reasoningEffort);
        for (const sub of ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate']) {
          await injectAgentFrontmatter(join(agentsDest, `${sub}.md`), subagentModel, reasoningEffort);
        }
        logger.info(`Injected agent frontmatter`, { component: 'routes', operation: 'inject_frontmatter', main_model: mainModel, subagent_model: subagentModel, reasoning_effort: reasoningEffort });
      } catch (err) {
        logger.error('Failed to inject agent frontmatter', err, { component: 'routes', operation: 'inject_frontmatter' });
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
              logger.error('Failed to add git worktree with existing branch', err2, { component: 'routes', operation: 'git_worktree', branch_name: branchName });
              return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
            }
          } else {
            logger.error('Failed to add git worktree', err, { component: 'routes', operation: 'git_worktree', branch_name: branchName });
            return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
          }
        }
        repoName = await getGitRepoName(existingPath);
        logger.info(`Created worktree`, { component: 'routes', operation: 'git_worktree', workspace_dir: workspaceDir, existing_path: existingPath, branch_name: branchName, repo_name: repoName });
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

      const opencodeEnv = typeof input.opencodeEnv === 'string' ? input.opencodeEnv.trim() : 'external';

      if (opencodeEnv === 'random') {
        try {
          logger.info(`Getting/creating OpenCode process`, { component: 'routes', operation: 'opencode_create', project_dir: projectDir });
          const created = await OpenCodeManager.getOrCreate(projectDir);
          client = created.client;
          logger.info(`OpenCode process ready`, { component: 'routes', operation: 'opencode_ready', opencode_url: created.process.url });
          opencodeUrl = created.process.url;

          logger.info(`Creating OpenCode session with title: ${projectName}`, { component: 'routes', operation: 'opencode_session', project_name: projectName });
          const opencodeSession = await client.createSession({
            title: projectName,
          });
          opencodeSessionId = opencodeSession.id;
          logger.info(`OpenCode session created`, { component: 'routes', operation: 'opencode_session', opencode_session_id: opencodeSessionId });
        } catch (error) {
          logger.error('Failed to create OpenCode session', error, { component: 'routes', operation: 'opencode_create' });
          return reply.status(502).send({
            error: 'Failed to create session with OpenCode',
          });
        }
      } else {
        isExternal = true;
        opencodeUrl = input.opencodeUrl && typeof input.opencodeUrl === 'string' && input.opencodeUrl.trim()
          ? input.opencodeUrl.trim()
          : 'http://127.0.0.1:4096';
        try {
          const external = OpenCodeManager.getOrCreateExternal(projectDir, opencodeUrl, { extraHeaders, auth });
          client = external.client;
          logger.info(`Using external OpenCode`, { component: 'routes', operation: 'opencode_external', opencode_url: opencodeUrl });
          const opencodeSession = await client.createSession({ title: projectName });
          opencodeSessionId = opencodeSession.id;
          logger.info(`OpenCode session created on external server`, { component: 'routes', operation: 'opencode_session', opencode_session_id: opencodeSessionId });
        } catch (error) {
          logger.error('Failed to connect to external OpenCode', error, { component: 'routes', operation: 'opencode_external', opencode_url: opencodeUrl });
          return reply.status(502).send({ error: 'Failed to connect to external OpenCode server' });
        }
      }

      const sessionId = generateId();
      logger.info(`AICoder session created`, { component: 'routes', operation: 'session_created', session_id: sessionId, opencode_session_id: opencodeSessionId });

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
            '',
            '',
            '',
            mainModel,
            subagentModel
          );
        });
      } catch (error) {
        logger.error('Failed to create session in database', error, { component: 'routes', operation: 'db_insert', session_id: sessionId });
        return reply.status(500).send({
          error: 'Failed to create session',
        });
      }

      const model = mainModel;
      const userInput = requireString(input.requirements, 'requirements');
      const rawMode = typeof input.pipelineMode === 'string' ? input.pipelineMode.trim() : 'standard';
      const pipelineMode: PipelineMode = ['full', 'standard', 'simple'].includes(rawMode) ? (rawMode as PipelineMode) : 'standard';
      const stageOrder = getStageOrder(pipelineMode);

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
        stageOrder,
        (event) => {
          try {
            (fastify as any).broadcastEvent(event);
          } catch {}
        }
      );

      const maybeShutdownTempProcess = () => {
        if (!isExternal && OpenCodeManager.isManagedProcess(projectDir)) {
          logger.info(`Shutting down temporary OpenCode process`, { component: 'routes', operation: 'shutdown_process', session_id: sessionId });
          OpenCodeManager.shutdown(projectDir);
        }
      };

      const sessionLogger = createSessionLogger(sessionId);
      executePipeline({
        sessionId,
        opencodeSessionId,
        userInput,
        workspaceDir,
        projectDir,
        client,
        model,
        mode: pipelineMode,
        reasoningEffort,
      }).then((result) => {
        sessionLogger.info(`Pipeline completed`, { operation: 'pipeline_complete' });
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
        sessionLogger.error(`Pipeline failed`, error, { operation: 'pipeline_fail' });
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
        'SELECT id, opencode_session_id, status, opencode_url, project_path, workspace_path, repo_name, current_agent, latest_message, messages_json, stages_json, created_at, completed_at FROM sessions WHERE id = ?',
      ).get(id) as { id: string; opencode_session_id?: string; status: string; opencode_url?: string; project_path?: string; workspace_path?: string; repo_name?: string; current_agent?: string; latest_message?: string; messages_json?: string; stages_json?: string; created_at: number; completed_at?: number } | undefined;

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
        logger.warn(`Failed to remove project directory`, { component: 'routes', operation: 'delete_session', session_id: id, project_path: session.project_path, error: err instanceof Error ? err.message : String(err) });
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

function startProgressPolling(
  client: OpenCodeClient,
  sessionId: string,
  opencodeSessionId: string,
  projectDir: string,
  stageOrder: import('./pipeline').PipelineStage[],
  broadcast: (event: SSEEvent) => void
): () => void {
  let running = true;
  let lastStagesSnapshot: Record<string, { status: string }> | null = null;
  let lastCurrentStage: string | null = null;

  // Server-side accumulated message history
  const accumulatedMessages: string[] = [];
  const seenMessageTexts = new Set<string>();

  // Hydrate from DB if server restarted
  try {
    const row = db.prepare('SELECT messages_json FROM sessions WHERE id = ?').get(sessionId) as { messages_json?: string } | undefined;
    if (row?.messages_json) {
      const parsed = JSON.parse(row.messages_json) as string[];
      for (const msg of parsed) {
        if (msg && !seenMessageTexts.has(msg)) {
          seenMessageTexts.add(msg);
          accumulatedMessages.push(msg);
        }
      }
    }
  } catch {
    // ignore hydration errors
  }

  const poll = async () => {
    if (!running) return;
    try {
      // 1) Infer stage from status.yaml, fallback to checkpoint.json, then to last known
      let currentStage: string;
      let stagesSnapshot: Record<string, { status: string }>;
      const statusFromYaml = await readStatusFile(sessionId, projectDir);
      if (statusFromYaml) {
        currentStage = statusFromYaml.pipeline.current_stage;
        const effectiveOrder = statusFromYaml.stage_order && statusFromYaml.stage_order.length > 0
          ? statusFromYaml.stage_order
          : stageOrder;
        stagesSnapshot = {};
        for (const stage of effectiveOrder) {
          stagesSnapshot[stage] = { status: statusFromYaml.stages[stage].status };
        }
      } else {
        // Fallback: read checkpoint.json directly
        const checkpointPath = join(projectDir, `run-${sessionId}`, 'checkpoint.json');
        let checkpointCurrentStageIndex = -1;
        let checkpointOrder: string[] = [];
        let checkpointStages: Record<string, { status: string }> = {};
        try {
          const cpContent = await readFile(checkpointPath, 'utf-8');
          const cp = JSON.parse(cpContent) as {
            current_stage_index?: number;
            stage_order?: string[];
            stages?: Record<string, { status: string }>;
          };
          if (typeof cp.current_stage_index === 'number') checkpointCurrentStageIndex = cp.current_stage_index;
          if (Array.isArray(cp.stage_order)) checkpointOrder = cp.stage_order;
          if (cp.stages && typeof cp.stages === 'object') checkpointStages = cp.stages;
        } catch {
          // ignore checkpoint read errors
        }

        if (checkpointOrder.length > 0) {
          const idx = checkpointCurrentStageIndex >= 0 ? checkpointCurrentStageIndex : 0;
          currentStage = idx >= checkpointOrder.length ? 'completed' : checkpointOrder[idx];
          stagesSnapshot = {};
          for (let i = 0; i < checkpointOrder.length; i++) {
            const stage = checkpointOrder[i];
            const stageStatus = checkpointStages[stage]?.status || 'pending';
            if (i < idx) {
              stagesSnapshot[stage] = { status: stageStatus === 'completed' ? 'completed' : stageStatus };
            } else if (i === idx && currentStage !== 'completed') {
              stagesSnapshot[stage] = { status: stageStatus === 'pending' ? 'running' : stageStatus };
            } else {
              stagesSnapshot[stage] = { status: 'pending' };
            }
          }
        } else if (lastCurrentStage && lastStagesSnapshot) {
          currentStage = lastCurrentStage;
          stagesSnapshot = { ...lastStagesSnapshot };
        } else {
          currentStage = stageOrder[0] || 'completed';
          stagesSnapshot = {};
          for (let i = 0; i < stageOrder.length; i++) {
            stagesSnapshot[stageOrder[i]] = { status: i === 0 ? 'running' : 'pending' };
          }
        }
      }

      lastStagesSnapshot = stagesSnapshot;
      lastCurrentStage = currentStage;

      const completedStages = stageOrder.filter((s) => stagesSnapshot[s]?.status === 'completed').length;
      const progressPercent = Math.round((completedStages / stageOrder.length) * 100);
      const currentAgent = currentStage === 'completed' ? 'completed' : `${currentStage} agent`;

      // 2) Accumulate assistant messages server-side
      let latestMessage = '';
      try {
        const messages = await client.getMessages(opencodeSessionId);
        for (const msg of messages) {
          if (msg.role === 'assistant' && msg.parts) {
            const textParts = msg.parts
              .filter((p) => (p.type === 'text' || p.type === 'reasoning') && p.text)
              .map((p) => p.text as string);
            const joined = textParts.join('\n').trim();
            if (joined && !seenMessageTexts.has(joined)) {
              seenMessageTexts.add(joined);
              accumulatedMessages.push(joined);
            }
          }
        }
        if (accumulatedMessages.length > 0) {
          latestMessage = accumulatedMessages[accumulatedMessages.length - 1].slice(0, 800);
        }
      } catch {
        // ignore message fetch errors
      }

      const stagesJson = JSON.stringify(stagesSnapshot);
      const messagesJson = JSON.stringify(accumulatedMessages);

      // 3) Update DB
      db.prepare(
        `UPDATE sessions SET current_agent = ?, latest_message = ?, messages_json = ?, stages_json = ? WHERE id = ?`
      ).run(currentAgent, latestMessage, messagesJson, stagesJson, sessionId);

      // 4) Broadcast
      broadcast({
        type: 'progress',
        properties: {
          session_id: sessionId,
          current_stage: currentStage,
          current_agent: currentAgent,
          latest_message: latestMessage,
          messages_json: messagesJson,
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
