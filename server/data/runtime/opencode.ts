/**
 * OpenCode implementation of AgentRuntime
 */

import { join } from 'path';
import { mkdir, cp, readFile, writeFile } from 'fs/promises';
import { OpenCodeManager, OpenCodeClient } from '../opencode.js';
import type {
  AgentRuntime,
  PromptPart,
  MessageInfo,
  SSEEvent,
  ModelInfo,
  SessionInfo,
} from './types.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('runtime-opencode');

export interface OpenCodeRuntimeConfig {
  type: 'opencode';
  mode?: 'random' | 'external';
  url?: string;
  header?: string;
  username?: string;
  password?: string;
}

export class OpenCodeRuntime implements AgentRuntime {
  private client: OpenCodeClient;
  private projectDir: string | null = null;
  private isManagedProcess = false;

  constructor(opts: { client: OpenCodeClient; isManagedProcess?: boolean }) {
    this.client = opts.client;
    this.isManagedProcess = opts.isManagedProcess || false;
  }

  async prepareEnvironment(
    projectDir: string,
    config: {
      mainModel: string;
      subagentModel: string;
      reasoningEffort?: string;
    }
  ): Promise<void> {
    this.projectDir = projectDir;
    log.info('Preparing OpenCode environment', { project_dir: projectDir });

    await mkdir(join(projectDir, '.opencode'), { recursive: true });
    await mkdir(join(projectDir, '.opencode', 'agent'), { recursive: true });
    await mkdir(join(projectDir, 'schemas'), { recursive: true });

    const agentsSrc = join(process.cwd(), 'agents');
    const agentsDest = join(projectDir, '.opencode', 'agent');
    const schemasSrc = join(process.cwd(), 'schemas');
    const schemasDest = join(projectDir, 'schemas');

    try {
      await cp(agentsSrc, agentsDest, { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to copy agents directory, continuing...', { error: error instanceof Error ? error.message : String(error) });
    }

    try {
      await cp(schemasSrc, schemasDest, { recursive: true, force: true });
    } catch (error) {
      log.warn('Failed to copy schemas directory, continuing...', { error: error instanceof Error ? error.message : String(error) });
    }

    try {
      await injectAgentFrontmatter(join(agentsDest, 'AICoder.md'), config.mainModel, config.reasoningEffort);
      for (const sub of ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate']) {
        await injectAgentFrontmatter(join(agentsDest, `${sub}.md`), config.subagentModel, config.reasoningEffort);
      }
      log.info('Injected agent frontmatter', { main_model: config.mainModel, subagent_model: config.subagentModel });
    } catch (err) {
      log.error('Failed to inject agent frontmatter', err);
      throw err;
    }
  }

  async createSession(opts?: { title?: string; parentID?: string }): Promise<SessionInfo> {
    return this.client.createSession(opts);
  }

  async sendMessage(
    sessionId: string,
    parts: PromptPart[],
    opts?: { agent?: string; model?: string; noReply?: boolean; reasoningEffort?: string }
  ): Promise<void> {
    return this.client.sendMessage(sessionId, parts, opts);
  }

  async getMessages(sessionId: string): Promise<MessageInfo[]> {
    return this.client.getMessages(sessionId);
  }

  async getModels(): Promise<ModelInfo[]> {
    return this.client.getModels();
  }

  subscribeEvents(onEvent: (event: SSEEvent) => void): () => void {
    return this.client.subscribeEvents(onEvent);
  }

  shutdown(projectDir?: string): void {
    const dir = projectDir || this.projectDir;
    if (dir && this.isManagedProcess) {
      log.info('Shutting down managed OpenCode process', { project_dir: dir });
      OpenCodeManager.shutdown(dir);
    }
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

export async function createOpenCodeRuntime(
  projectDir: string,
  runtimeConfig?: OpenCodeRuntimeConfig
): Promise<OpenCodeRuntime> {
  const mode = runtimeConfig?.mode || 'external';

  if (mode === 'random') {
    const created = await OpenCodeManager.getOrCreate(projectDir);
    return new OpenCodeRuntime({ client: created.client, isManagedProcess: true });
  }

  const url = runtimeConfig?.url?.trim() || 'http://127.0.0.1:4096';
  const extraHeaders: Record<string, string> = {};
  if (runtimeConfig?.header && runtimeConfig.header.trim()) {
    const headerStr = runtimeConfig.header.trim();
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

  const auth = runtimeConfig?.username && runtimeConfig?.password
    ? { username: runtimeConfig.username, password: runtimeConfig.password }
    : undefined;

  const { client } = OpenCodeManager.getOrCreateExternal(projectDir, url, { extraHeaders, auth });
  return new OpenCodeRuntime({ client, isManagedProcess: false });
}
