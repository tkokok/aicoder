import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from '../db.js';
import { validateSessionInput, SessionInput } from '../validation.js';
import { mkdir, cp, rm, stat, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentClient } from './client/agent-client.js';
import { createSessionLogger, logger } from '../logger.js';
import type { PipelineMode } from '../shared/types.js';
import { getStageOrder } from '../shared/constants.js';

const execAsync = promisify(exec);

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

function getAgentUrl(): string {
  return process.env.DEFAULT_AGENT_URL || 'http://localhost:8443';
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

async function createProjectDirectory(projectName: string): Promise<string> {
  const sanitized = sanitizeProjectName(projectName);
  const baseDir = join(homedir(), '.aicoder', 'projects', sanitized);

  await mkdir(join(baseDir, '.opencode'), { recursive: true });
  await mkdir(join(baseDir, '.opencode', 'agent'), { recursive: true });
  await mkdir(join(baseDir, 'workspace'), { recursive: true });
  await mkdir(join(baseDir, 'logs'), { recursive: true });

  const agentsSrc = join(process.cwd(), 'agents');
  const agentsDest = join(baseDir, '.opencode', 'agent');
  const schemasSrc = join(process.cwd(), 'schemas');
  const schemasDest = join(baseDir, 'schemas');

  try {
    await cp(agentsSrc, agentsDest, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to copy agents directory, continuing...', { component: 'control-routes', operation: 'copy_agents', error: error instanceof Error ? error.message : String(error) });
  }

  try {
    await cp(schemasSrc, schemasDest, { recursive: true, force: true });
  } catch (error) {
    logger.warn('Failed to copy schemas directory, continuing...', { component: 'control-routes', operation: 'copy_schemas', error: error instanceof Error ? error.message : String(error) });
  }

  return baseDir;
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git init', { cwd: dir });
  } catch (error) {
    logger.warn('Failed to initialize git repo, continuing...', { component: 'control-routes', operation: 'git_init', error: error instanceof Error ? error.message : String(error) });
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
    const match = url.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
    return basename(url, '.git') || null;
  } catch {
    return null;
  }
}

export async function registerControlRoutes(fastify: FastifyInstance): Promise<void> {
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
      const agentClient = new AgentClient(getAgentUrl());
      const result = await agentClient.getModels();
      return reply.send(result);
    } catch (error) {
      logger.error('Failed to fetch models via agent', error, { component: 'control-routes', operation: 'fetch_models' });
      return reply.status(502).send({
        models: [],
        default: 'zhipuai-coding-plan/glm-4.7-flashx',
        error: 'Failed to fetch models from agent',
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
        return reply.status(400).send({ error: 'Validation failed', errors: validation.errors });
      }

      const projectName = requireString(input.projectName, 'projectName');
      const mode = typeof input.mode === 'string' && input.mode.trim() === 'existing' ? 'existing' : 'new';
      logger.info(`Creating session for project: ${projectName}`, { component: 'control-routes', operation: 'create_session', project_name: projectName, mode });

      let projectDir: string;
      try {
        projectDir = await createProjectDirectory(projectName);
      } catch (error) {
        logger.error('Failed to create project directory', error, { component: 'control-routes', operation: 'create_project_dir', project_name: projectName });
        return reply.status(500).send({ error: 'Failed to create project directory' });
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
      } catch (err) {
        logger.error('Failed to inject agent frontmatter', err, { component: 'control-routes', operation: 'inject_frontmatter' });
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
        try {
          await execAsync('git rev-parse --git-dir', { cwd: existingPath });
        } catch {
          return reply.status(400).send({ error: 'Existing project path is not a git repository' });
        }
        workspaceDir = join(projectDir, 'workspace');
        try {
          await rm(workspaceDir, { recursive: true, force: true });
        } catch {}
        const branchName = `aicoder-${sanitizeProjectName(projectName)}`;
        try {
          await execAsync(`git worktree add "${workspaceDir}" -b ${branchName}`, { cwd: existingPath });
        } catch (err: any) {
          if (err?.stderr?.includes('already exists') || err?.message?.includes('already exists')) {
            try {
              await execAsync(`git worktree add "${workspaceDir}" ${branchName}`, { cwd: existingPath });
            } catch (err2: any) {
              logger.error('Failed to add git worktree with existing branch', err2, { component: 'control-routes', operation: 'git_worktree', branch_name: branchName });
              return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
            }
          } else {
            logger.error('Failed to add git worktree', err, { component: 'control-routes', operation: 'git_worktree', branch_name: branchName });
            return reply.status(500).send({ error: 'Failed to create git worktree from existing project' });
          }
        }
        repoName = await getGitRepoName(existingPath);
      } else {
        workspaceDir = join(projectDir, 'workspace');
        await initGitRepo(workspaceDir);
      }

      const sessionId = generateId();
      const rawMode = typeof input.pipelineMode === 'string' ? input.pipelineMode.trim() : 'standard';
      const pipelineMode: PipelineMode = ['full', 'standard', 'simple'].includes(rawMode) ? (rawMode as PipelineMode) : 'standard';
      const stageOrder = getStageOrder(pipelineMode);
      const userInput = requireString(input.requirements, 'requirements');

      // Build playbook on control side
      const { buildPipelinePlaybook } = await import('../prompts/pipeline-dispatch.js');
      const playbook = buildPipelinePlaybook({
        mode: pipelineMode,
        stageOrder,
        sessionId,
        projectDir,
        workspaceDir,
        userInput,
      });

      try {
        transaction(() => {
          db.prepare(
            `INSERT INTO sessions (id, project_path, workspace_path, repo_name, status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)`
          ).run(sessionId, projectDir, workspaceDir, repoName || '', Date.now());

          db.prepare(
            `INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method, model, subagent_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            sessionId,
            projectName,
            userInput,
            '',
            '',
            '',
            mainModel,
            subagentModel
          );
        });
      } catch (error) {
        logger.error('Failed to create session in database', error, { component: 'control-routes', operation: 'db_insert', session_id: sessionId });
        return reply.status(500).send({ error: 'Failed to create session' });
      }

      // Call data plane to start pipeline
      const agentClient = new AgentClient(getAgentUrl());
      try {
        const startRes = await agentClient.startPipeline({
          sessionId,
          opencodeSessionId: '', // data plane will create it
          playbook,
          workspaceDir,
          projectDir,
          mode: pipelineMode,
          model: mainModel,
          reasoningEffort,
          opencodeEnv: (input.opencodeEnv as 'random' | 'external') || 'external',
          opencodeUrl: typeof input.opencodeUrl === 'string' ? input.opencodeUrl : undefined,
          opencodeHeader: typeof input.opencodeHeader === 'string' ? input.opencodeHeader : undefined,
          opencodeUsername: typeof input.opencodeUsername === 'string' ? input.opencodeUsername : undefined,
          opencodePassword: typeof input.opencodePassword === 'string' ? input.opencodePassword : undefined,
        });

        // Update DB with opencode info returned by data plane
        db.prepare(
          `UPDATE sessions SET opencode_session_id = ?, opencode_url = ? WHERE id = ?`
        ).run(startRes.opencodeSessionId, startRes.opencodeUrl, sessionId);

        return reply.status(201).send({
          id: sessionId,
          status: 'pending',
          opencode_url: startRes.opencodeUrl,
        } as SessionResponse);
      } catch (error) {
        logger.error('Failed to start pipeline on agent', error, { component: 'control-routes', operation: 'start_pipeline', session_id: sessionId });
        // Mark as failed
        db.prepare(`UPDATE sessions SET status = 'failed', completed_at = ? WHERE id = ?`).run(Date.now(), sessionId);
        return reply.status(502).send({ error: 'Failed to start pipeline on agent' });
      }
    }
  );

  fastify.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = db.prepare(
      'SELECT id, opencode_session_id, status, opencode_url, project_path, workspace_path, repo_name, current_agent, latest_message, messages_json, stages_json, created_at, completed_at FROM sessions WHERE id = ?'
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

    return reply.send({ ...session, stages: stagesObj });
  });

  fastify.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = db.prepare('SELECT id, project_path FROM sessions WHERE id = ?').get(id) as { id: string; project_path: string } | undefined;
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    try {
      const agentClient = new AgentClient(getAgentUrl());
      await agentClient.stopPipeline(id);
    } catch {
      // ignore
    }

    transaction(() => {
      db.prepare('DELETE FROM session_reports WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM session_inputs WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });

    try {
      await rm(session.project_path, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to remove project directory', { component: 'control-routes', operation: 'delete_session', session_id: id, project_path: session.project_path, error: err instanceof Error ? err.message : String(err) });
    }

    return reply.status(204).send();
  });

  fastify.get<{ Params: { id: string } }>('/api/sessions/:id/report', async (request, reply) => {
    const { id } = request.params;
    const session = db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(id) as { id: string; status: string } | undefined;
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (session.status === 'completed') {
      const report = db.prepare('SELECT report_markdown FROM session_reports WHERE session_id = ?').get(id) as { report_markdown: string } | undefined;
      if (!report) {
        return reply.status(404).send({ error: 'Report not found for completed session' });
      }
      return reply.send({ markdown: report.report_markdown });
    }

    return reply.send({ status: session.status });
  });
}
