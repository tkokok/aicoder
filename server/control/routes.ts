import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, transaction, generateId } from '../db.js';
import { validateSessionInput, SessionInput } from '../validation.js';
import { mkdir, rm, stat } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { AgentClient, getAgentUrl } from './client/agent-client.js';
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
  agentId?: unknown;
  reasoningEffort?: unknown;
}

interface AgentBody {
  name: unknown;
  agentUrl: unknown;
  runtimeConfig?: unknown;
  runtimeLink?: unknown;
  model?: unknown;
  subagentModel?: unknown;
}

interface SessionResponse {
  id: string;
  status: string;
  runtime_url?: string;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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

  await mkdir(join(baseDir, 'workspace'), { recursive: true });
  await mkdir(join(baseDir, 'logs'), { recursive: true });

  return baseDir;
}

async function initGitRepo(dir: string): Promise<void> {
  try {
    await execAsync('git init', { cwd: dir });
  } catch (error) {
    logger.warn('Failed to initialize git repo, continuing...', { component: 'control-routes', operation: 'git_init', error: error instanceof Error ? error.message : String(error) });
  }
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
  fastify.get('/api/config', async (_request, reply) => {
    return reply.send({ useDataPlane: true });
  });

  fastify.get('/api/agents', async (_request, reply) => {
    const rows = db.prepare(
      'SELECT id, name, agent_url, runtime_config, runtime_link, main_model, subagent_model, created_at FROM agents ORDER BY created_at DESC'
    ).all() as Array<{
      id: string;
      name: string;
      agent_url: string;
      runtime_config?: string;
      runtime_link?: string;
      main_model?: string;
      subagent_model?: string;
      created_at: number;
    }>;
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        agentUrl: r.agent_url,
        runtimeConfig: r.runtime_config || null,
        runtimeLink: r.runtime_link || null,
        model: r.main_model || null,
        subagentModel: r.subagent_model || null,
        createdAt: r.created_at,
      }))
    );
  });

  fastify.post('/api/agents/test-connection', async (request, reply) => {
    const body = request.body as { runtimeConfig?: string };
    const runtimeConfig = typeof body.runtimeConfig === 'string' ? body.runtimeConfig.trim() : '';
    
    try {
      const { createAgentRuntime } = await import('../data/runtime/factory.js');
      const tempDir = process.env.TEMP_DIR || '/tmp/aicoder-test';
      const { mkdir } = await import('fs/promises');
      await mkdir(tempDir, { recursive: true });
      
      const runtime = await createAgentRuntime(tempDir, runtimeConfig || undefined);
      const models = await runtime.getModels();
      runtime.shutdown(tempDir);
      
      return reply.send({ success: true, models });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ success: false, error: msg });
    }
  });

  fastify.post<{ Body: AgentBody }>('/api/agents', async (request, reply) => {
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
    const agentUrl = typeof request.body.agentUrl === 'string' ? request.body.agentUrl.trim() : '';
    const runtimeConfig = typeof request.body.runtimeConfig === 'string' ? request.body.runtimeConfig.trim() : '';
    const runtimeLink = typeof request.body.runtimeLink === 'string' ? request.body.runtimeLink.trim() : '';
    const model = typeof request.body.model === 'string' ? request.body.model.trim() : '';
    const subagentModel = typeof request.body.subagentModel === 'string' ? request.body.subagentModel.trim() : '';

    const errors: string[] = [];
    if (!name) errors.push('Name is required');
    if (!agentUrl) errors.push('Agent URL is required');
    else if (!isValidHttpUrl(agentUrl)) errors.push('Agent URL must be a valid HTTP/HTTPS URL');
    if (runtimeLink && !isValidHttpUrl(runtimeLink)) errors.push('Runtime link must be a valid HTTP/HTTPS URL');

    if (errors.length > 0) {
      return reply.status(400).send({ error: 'Validation failed', errors });
    }

    try {
      const client = new AgentClient(agentUrl);
      await client.healthCheck();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Agent health check failed', errors: [msg] });
    }

    const id = generateId();
    db.prepare(
      'INSERT INTO agents (id, name, agent_url, runtime_config, runtime_link, main_model, subagent_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, agentUrl, runtimeConfig || null, runtimeLink || null, model || null, subagentModel || null, Date.now());

    return reply.status(201).send({ id, name, agentUrl, runtimeConfig, runtimeLink, model, subagentModel });
  });

  fastify.put<{ Params: { id: string }; Body: AgentBody }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
    const agentUrl = typeof request.body.agentUrl === 'string' ? request.body.agentUrl.trim() : '';
    const runtimeConfig = typeof request.body.runtimeConfig === 'string' ? request.body.runtimeConfig.trim() : '';
    const runtimeLink = typeof request.body.runtimeLink === 'string' ? request.body.runtimeLink.trim() : '';
    const model = typeof request.body.model === 'string' ? request.body.model.trim() : '';
    const subagentModel = typeof request.body.subagentModel === 'string' ? request.body.subagentModel.trim() : '';

    const errors: string[] = [];
    if (!name) errors.push('Name is required');
    if (!agentUrl) errors.push('Agent URL is required');
    else if (!isValidHttpUrl(agentUrl)) errors.push('Agent URL must be a valid HTTP/HTTPS URL');
    if (runtimeLink && !isValidHttpUrl(runtimeLink)) errors.push('Runtime link must be a valid HTTP/HTTPS URL');

    if (errors.length > 0) {
      return reply.status(400).send({ error: 'Validation failed', errors });
    }

    try {
      const client = new AgentClient(agentUrl);
      await client.healthCheck();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Agent health check failed', errors: [msg] });
    }

    const result = db.prepare(
      'UPDATE agents SET name = ?, agent_url = ?, runtime_config = ?, runtime_link = ?, main_model = ?, subagent_model = ? WHERE id = ?'
    ).run(name, agentUrl, runtimeConfig || null, runtimeLink || null, model || null, subagentModel || null, id);

    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    return reply.send({ id, name, agentUrl, runtimeConfig, runtimeLink, model, subagentModel });
  });

  fastify.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    if (result.changes === 0) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    return reply.status(204).send();
  });

  fastify.get('/api/sessions', async (_request, reply) => {
    const rows = db.prepare(`
      SELECT
        s.id,
        s.status,
        COALESCE(a.runtime_link, '') as runtime_url,
        s.current_agent,
        s.created_at,
        s.completed_at,
        s.agent_id,
        a.name as agent_name,
        si.project_name,
        si.requirements,
        si.tech_stack
      FROM sessions s
      LEFT JOIN session_inputs si ON s.id = si.session_id
      LEFT JOIN agents a ON s.agent_id = a.id
      ORDER BY s.created_at DESC
    `).all() as Array<{
      id: string;
      status: string;
      runtime_url?: string;
      current_agent?: string;
      created_at: number;
      completed_at?: number;
      agent_id?: string;
      agent_name?: string;
      project_name: string;
      requirements: string;
      tech_stack: string;
    }>;

    return reply.send(
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        runtime_url: r.runtime_url || null,
        current_agent: r.current_agent || null,
        agent_name: r.agent_name || (r.agent_id ? r.agent_id : 'local'),
        project_name: r.project_name,
        requirements: r.requirements,
        tech_stack: r.tech_stack,
        created_at: r.created_at,
        completed_at: r.completed_at || null,
      }))
    );
  });

  fastify.get('/api/models', async (_request, reply) => {
    let agentUrl = getAgentUrl();
    if (agentUrl === 'http://localhost:2080') {
      const row = db.prepare('SELECT agent_url FROM agents ORDER BY created_at DESC LIMIT 1').get() as { agent_url: string } | undefined;
      if (row) agentUrl = row.agent_url;
    }
    try {
      const agentClient = new AgentClient(agentUrl);
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
        agentId: request.body.agentId,
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

      const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
      if (!agentId) {
        return reply.status(400).send({ error: 'Validation failed', errors: ['Agent is required'] });
      }
      const agent = db.prepare('SELECT id, name, agent_url, runtime_config, runtime_link, main_model, subagent_model FROM agents WHERE id = ?').get(agentId) as { id: string; name: string; agent_url: string; runtime_config?: string; runtime_link?: string; main_model?: string; subagent_model?: string } | undefined;
      if (!agent) {
        return reply.status(400).send({ error: 'Validation failed', errors: ['Selected agent not found'] });
      }

      const mainModel = input.model && typeof input.model === 'string' 
        ? input.model 
        : agent.main_model || 'zhipuai-coding-plan/glm-4.7-flashx';
      const subagentModel = input.subagentModel && typeof input.subagentModel === 'string' 
        ? input.subagentModel 
        : agent.subagent_model || 'zhipuai-coding-plan/glm-4.7-flashx';

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

      const agentClient = new AgentClient(agent.agent_url);
      const startPipelineParams = {
        sessionId,
        playbook,
        workspaceDir,
        projectDir,
        mode: pipelineMode,
        model: mainModel,
        subagentModel,
        reasoningEffort: input.reasoningEffort && typeof input.reasoningEffort === 'string' ? input.reasoningEffort : 'low',
        runtimeConfig: agent.runtime_config || undefined,
      };

      try {
        const startRes = await agentClient.startPipeline(startPipelineParams);

        db.prepare(
          `UPDATE sessions SET data_plane_session_id = ?, agent_id = ? WHERE id = ?`
        ).run(startRes.dataPlaneSessionId, agentId, sessionId);

        return reply.status(201).send({
          id: sessionId,
          status: 'pending',
          runtime_url: startRes.runtimeUrl || agent.runtime_link || null,
        } as SessionResponse);
      } catch (error) {
        logger.error('Failed to start pipeline on agent', error, { component: 'control-routes', operation: 'start_pipeline', session_id: sessionId });
        db.prepare(`UPDATE sessions SET status = 'failed', completed_at = ? WHERE id = ?`).run(Date.now(), sessionId);
        return reply.status(502).send({ error: 'Failed to start pipeline on agent' });
      }
    }
  );

  fastify.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = db.prepare(`
      SELECT
        s.id,
        s.data_plane_session_id,
        s.status,
        s.project_path,
        s.workspace_path,
        s.repo_name,
        s.current_agent,
        s.latest_message,
        s.messages_json,
        s.stages_json,
        s.created_at,
        s.completed_at,
        COALESCE(a.runtime_link, '') as runtime_url
      FROM sessions s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.id = ?
    `).get(id) as { id: string; data_plane_session_id?: string; status: string; project_path?: string; workspace_path?: string; repo_name?: string; current_agent?: string; latest_message?: string; messages_json?: string; stages_json?: string; created_at: number; completed_at?: number; runtime_url?: string } | undefined;

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
    const session = db.prepare('SELECT id, agent_id FROM sessions WHERE id = ?').get(id) as { id: string; agent_id?: string } | undefined;
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    let agentUrl = getAgentUrl();
    if (session.agent_id) {
      const agent = db.prepare('SELECT agent_url FROM agents WHERE id = ?').get(session.agent_id) as { agent_url: string } | undefined;
      if (agent) agentUrl = agent.agent_url;
    }

    try {
      const agentClient = new AgentClient(agentUrl);
      await agentClient.stopPipeline(id);
    } catch {
      // ignore
    }

    transaction(() => {
      db.prepare('DELETE FROM session_reports WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM session_inputs WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });

    return reply.status(204).send();
  });

  fastify.post<{ Params: { id: string } }>('/api/sessions/:id/refresh', async (request, reply) => {
    const { id } = request.params;
    const session = db.prepare('SELECT id, status, agent_id FROM sessions WHERE id = ?').get(id) as { id: string; status: string; agent_id?: string } | undefined;
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    let agentUrl = getAgentUrl();
    if (session.agent_id) {
      const agent = db.prepare('SELECT agent_url FROM agents WHERE id = ?').get(session.agent_id) as { agent_url: string } | undefined;
      if (agent) agentUrl = agent.agent_url;
    }

    let running = false;
    try {
      const agentClient = new AgentClient(agentUrl);
      const statusRes = await agentClient.getPipelineStatus(id);
      running = statusRes.running;
    } catch {
      // If we can't reach the agent, assume not running
      running = false;
    }

    if (!running && session.status === 'running') {
      db.prepare(`UPDATE sessions SET status = 'failed', completed_at = ? WHERE id = ?`).run(Date.now(), id);
    }

    const refreshed = db.prepare(`
      SELECT
        s.id,
        s.data_plane_session_id,
        s.status,
        s.project_path,
        s.workspace_path,
        s.repo_name,
        s.current_agent,
        s.latest_message,
        s.messages_json,
        s.stages_json,
        s.created_at,
        s.completed_at,
        COALESCE(a.runtime_link, '') as runtime_url
      FROM sessions s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.id = ?
    `).get(id) as { id: string; data_plane_session_id?: string; status: string; project_path?: string; workspace_path?: string; repo_name?: string; current_agent?: string; latest_message?: string; messages_json?: string; stages_json?: string; created_at: number; completed_at?: number; runtime_url?: string } | undefined;

    let stagesObj: Record<string, unknown> | null = null;
    if (refreshed?.stages_json) {
      try {
        stagesObj = JSON.parse(refreshed.stages_json) as Record<string, unknown>;
      } catch {}
    }

    return reply.send({ ...refreshed, stages: stagesObj, synced: !running && session.status === 'running' });
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
