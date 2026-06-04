/**
 * OpenCode Process Manager + HTTP Client
 *
 * Manages OpenCode server subprocesses and provides HTTP API client.
 * Each project gets its own OpenCode process on a random port (20000-30000).
 */

import { createComponentLogger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

export interface MessagePart {
  type: string;
  text?: string;
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  finish?: string;
  time: { created: number };
}

export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; url: string; mime?: string; filename?: string };

export interface ModelInfo {
  id: string;
  name: string;
  providerID: string;
}

// ============================================================================
// Logger
// ============================================================================

const log = createComponentLogger('opencode');

// ============================================================================
// Port Allocation
// ============================================================================

const PORT_MIN = 20000;
const PORT_MAX = 30000;
const usedPorts = new Set<number>();

function allocatePort(): number {
  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('Failed to allocate a free port in range 20000-30000');
}

function releasePort(port: number): void {
  usedPorts.delete(port);
}

// ============================================================================
// OpenCode Process
// ============================================================================

class OpenCodeProcess {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private port: number;
  private hostname = '127.0.0.1';
  private projectDir: string;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.port = allocatePort();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    log.info(`Allocated port ${this.port} for project`, { operation: 'allocate_port', port: this.port, project_dir: projectDir });
    this.spawn();
  }

  private spawn(): void {
    const binaryPath = process.env.OPENCODE_BIN_PATH || `${process.env.HOME}/.opencode/bin/opencode`;
    const command = `${binaryPath} serve --port ${this.port} --hostname ${this.hostname}`;
    // Use bash -lc to load shell environment variables (e.g. from .bashrc / .bash_profile)
    const args = ['bash', '-lc', command];
    log.info(`Spawning OpenCode process`, { operation: 'spawn', command: args.join(' '), cwd: this.projectDir });

    this.process = Bun.spawn(args, {
      cwd: this.projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    log.info(`Subprocess started`, { operation: 'spawn', pid: this.process.pid });

    const stdout = this.process.stdout;
    if (!stdout || typeof stdout === 'number') {
      releasePort(this.port);
      this.readyReject(new Error('stdout is not a readable stream'));
      return;
    }
    const reader = stdout.getReader();

    // Also log stderr
    const stderr = this.process.stderr;
    if (stderr && typeof stderr !== 'number') {
      const stderrReader = stderr.getReader();
      const readStderr = async () => {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = decoder.decode(value);
          log.error(`Process stderr`, undefined, { operation: 'stderr', output: text.trim() });
        }
      };
      readStderr().catch(() => {});
    }

    const readOutput = async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.error(`stdout stream ended (process may have exited)`, undefined, { operation: 'stdout' });
          break;
        }

        const text = decoder.decode(value);
        log.debug(`Process stdout: ${text.trim()}`, { operation: 'stdout' });

        const match = text.match(/opencode server listening on http:\/\/([^:]+):(\d+)/);
        if (match) {
          log.info(`OpenCode server ready`, { operation: 'ready', url: `http://${match[1]}:${match[2]}` });
          this.readyResolve();
          return;
        }
      }
    };

    readOutput().catch((error) => {
      log.error(`Failed to read stdout`, error, { operation: 'stdout_read' });
      this.readyReject(new Error(`Failed to read stdout: ${error}`));
    });

    const timeout = setTimeout(() => {
      log.error(`Timeout waiting for server`, undefined, { operation: 'timeout', port: this.port });
      this.close();
      this.readyReject(new Error(`Timeout waiting for OpenCode server to start on port ${this.port}`));
    }, 5000);

    this.ready.then(() => {
      clearTimeout(timeout);
    }).catch(() => {
      clearTimeout(timeout);
    });
  }

  async waitForReady(): Promise<void> {
    return this.ready;
  }

  get url(): string {
    return `http://${this.hostname}:${this.port}`;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  close(): void {
    releasePort(this.port);
    if (this.process) {
      log.info(`Killing OpenCode process`, { operation: 'kill', pid: this.process.pid, port: this.port });
      this.process.kill();
      this.process = null;
    }
  }
}

// ============================================================================
// OpenCode Client
// ============================================================================

export interface OpenCodeClientAuth {
  username: string;
  password: string;
}

export class OpenCodeClient {
  private baseUrl: string;
  private directory: string;
  private extraHeaders: Record<string, string>;
  private auth: OpenCodeClientAuth | null;

  constructor(opts: { baseUrl: string; directory: string; extraHeaders?: Record<string, string>; auth?: OpenCodeClientAuth }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.directory = opts.directory;
    this.extraHeaders = opts.extraHeaders || {};
    this.auth = opts.auth || null;
    log.info(`Created OpenCode client`, { operation: 'create_client', base_url: this.baseUrl, directory: this.directory, has_auth: !!this.auth, has_extra_headers: Object.keys(this.extraHeaders).length > 0 });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-opencode-directory': this.directory,
      ...this.extraHeaders,
    };
    if (this.auth) {
      const encoded = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders();

    log.debug(`→ ${method} ${url}`, { operation: 'http_request', method, path });
    if (body) {
      log.debug(`  body: ${JSON.stringify(body).slice(0, 500)}`, { operation: 'http_request_body' });
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    log.debug(`← ${response.status} ${response.statusText}`, { operation: 'http_response', method, path, status: response.status });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`API error response`, undefined, { operation: 'http_error', method, path, status: response.status, body: errorText.slice(0, 500) });
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      log.debug(`  (204 No Content)`, { operation: 'http_response_empty' });
      return undefined as T;
    }

    const json = await response.json();
    log.debug(`  response received`, { operation: 'http_response_json' });
    return json;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/global/health`;
      log.debug(`Health check → GET ${url}`, { operation: 'health_check' });
      const response = await fetch(url, {
        headers: this.buildHeaders(),
      });
      const ok = response.status === 200;
      log.info(`Health check result: ${ok}`, { operation: 'health_check', status: response.status });
      return ok;
    } catch (error) {
      log.error(`Health check failed`, error, { operation: 'health_check' });
      return false;
    }
  }

  async createSession(opts?: { title?: string; parentID?: string }): Promise<SessionInfo> {
    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    if (opts?.parentID) body.parentID = opts.parentID;
    log.info(`Creating session`, { operation: 'create_session', title: opts?.title || '(default)', parent_id: opts?.parentID || '(none)' });
    const session = await this.request<SessionInfo>('POST', '/session', body);
    log.info(`Session created`, { operation: 'create_session', session_id: session.id, title: session.title });
    return session;
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    log.debug(`Getting session`, { operation: 'get_session', session_id: sessionId });
    return this.request<SessionInfo>('GET', `/session/${sessionId}`);
  }

  async archiveSession(sessionId: string): Promise<void> {
    log.info(`Archiving session`, { operation: 'archive_session', session_id: sessionId });
    try {
      await this.request<SessionInfo>('PATCH', `/session/${sessionId}`, {
        time: { archived: Date.now() },
      });
      log.info(`Session archived`, { operation: 'archive_session', session_id: sessionId });
    } catch (error) {
      log.error(`Failed to archive session`, error, { operation: 'archive_session', session_id: sessionId });
    }
  }

  forkDirectory(newDirectory: string): OpenCodeClient {
    return new OpenCodeClient({
      baseUrl: this.baseUrl,
      directory: newDirectory,
      extraHeaders: this.extraHeaders,
      auth: this.auth || undefined,
    });
  }

  async sendMessage(
    sessionId: string,
    parts: PromptPart[],
    opts?: { agent?: string; model?: string; noReply?: boolean; reasoningEffort?: string }
  ): Promise<void> {
    const body: { parts: PromptPart[]; agent?: string; model?: { providerID: string; modelID: string }; noReply?: boolean; reasoning_effort?: string } = { parts };
    if (opts?.agent) {
      body.agent = opts.agent;
    }
    if (opts?.model) {
      const slashIdx = opts.model.indexOf('/');
      if (slashIdx > 0) {
        body.model = { providerID: opts.model.slice(0, slashIdx), modelID: opts.model.slice(slashIdx + 1) };
      } else {
        body.model = { providerID: opts.model, modelID: opts.model };
      }
    }
    if (opts?.noReply) {
      body.noReply = true;
    }
    if (opts?.reasoningEffort) {
      body.reasoning_effort = opts.reasoningEffort;
    }
    log.info(`Sending message to session`, { operation: 'send_message', session_id: sessionId, agent: opts?.agent || 'default', no_reply: opts?.noReply || false });
    await this.request<void>('POST', `/session/${sessionId}/prompt_async`, body);
    log.debug(`Message sent (async)`, { operation: 'send_message', session_id: sessionId });
  }

  async getMessages(sessionId: string): Promise<MessageInfo[]> {
    log.debug(`Fetching messages for session`, { operation: 'get_messages', session_id: sessionId });
    const raw = await this.request<any[]>('GET', `/session/${sessionId}/message`);
    log.debug(`Got ${raw.length} raw messages`, { operation: 'get_messages', session_id: sessionId, count: raw.length });

    const mapped: MessageInfo[] = raw.map((m) => ({
      id: m.info?.id ?? m.id ?? '',
      sessionID: m.info?.sessionID ?? m.sessionID ?? '',
      role: m.info?.role ?? m.role ?? 'user',
      parts: (m.parts ?? []) as MessagePart[],
      finish: m.info?.finish ?? undefined,
      time: m.info?.time ?? m.time ?? { created: 0 },
      // Normalise OpenCode's free-form info blob into the typed MessageInfoMeta
      // surface. Defensive: every field is independently optional because
      // OpenCode's response shape varies across providers / message types.
      info: (m.info?.tokens || m.info?.cost || m.info?.modelID || m.info?.providerID)
        ? {
            tokens: m.info.tokens
              ? {
                  input: Number(m.info.tokens.input) || 0,
                  output: Number(m.info.tokens.output) || 0,
                  reasoning: m.info.tokens.reasoning != null ? Number(m.info.tokens.reasoning) : undefined,
                  cache: m.info.tokens.cache,
                }
              : undefined,
            cost: m.info.cost != null ? Number(m.info.cost) : undefined,
            modelID: m.info.modelID,
            providerID: m.info.providerID,
          }
        : undefined,
    }));

    return mapped;
  }

  async getModels(): Promise<ModelInfo[]> {
    log.info(`Fetching available models from /provider`, { operation: 'get_models' });
    interface ProviderModel {
      id: string;
      name?: string;
    }
    interface ProviderItem {
      id: string;
      name?: string;
      models: Record<string, ProviderModel>;
    }
    interface ProviderResponse {
      all: ProviderItem[];
      default: Record<string, string>;
      connected: string[];
    }
    const data = await this.request<ProviderResponse>('GET', '/provider');
    const connectedSet = new Set(data.connected);
    const models: ModelInfo[] = [];
    for (const provider of data.all) {
      if (!connectedSet.has(provider.id)) continue;
      for (const [modelID, model] of Object.entries(provider.models)) {
        models.push({
          id: `${provider.id}/${modelID}`,
          name: model.name || modelID,
          providerID: provider.id,
        });
      }
    }
    log.info(`Found models from connected providers`, { operation: 'get_models', model_count: models.length, provider_count: connectedSet.size });
    return models;
  }

  subscribeEvents(onEvent: (event: SSEEvent) => void): () => void {
    let aborted = false;
    const url = `${this.baseUrl}/event`;

    log.info(`Connecting to SSE`, { operation: 'sse_connect', url });

    const connect = async () => {
      try {
        const response = await fetch(url, {
          headers: this.buildHeaders(),
        });

        if (!response.ok) {
          log.error(`SSE connection failed`, undefined, { operation: 'sse_connect', status: response.status });
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        log.info(`SSE connected, reading stream...`, { operation: 'sse_connect' });

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) {
            log.debug(`SSE stream ended`, { operation: 'sse_stream' });
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              eventData = line.slice(5).trim();
            } else if (line === '' && eventData) {
              try {
                const data = JSON.parse(eventData);
                if (data.type !== 'heartbeat' && data.type !== 'server.heartbeat') {
                  log.debug(`SSE event received`, { operation: 'sse_event', event_type: data.type });
                  onEvent(data);
                }
              } catch {
                // Ignore parse errors
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      } catch (error) {
        if (!aborted) {
          log.error(`SSE connection error`, error, { operation: 'sse_connect' });
        }
      }
    };

    connect();

    return () => {
      log.info(`Unsubscribing from SSE`, { operation: 'sse_unsubscribe' });
      aborted = true;
    };
  }
}

// ============================================================================
// OpenCode Manager
// ============================================================================

class OpenCodeManagerImpl {
  private processes: Map<string, OpenCodeProcess> = new Map();
  private clients: Map<string, OpenCodeClient> = new Map();
  // Track which project dirs are using an external (user-provided) opencode server
  private externalDirs: Set<string> = new Set();

  async getOrCreate(projectDir: string): Promise<{
    process: OpenCodeProcess;
    client: OpenCodeClient;
  }> {
    const existingProcess = this.processes.get(projectDir);
    if (existingProcess) {
      const existingClient = this.clients.get(projectDir);
      if (existingClient) {
        log.info(`Reusing existing process`, { operation: 'manager_reuse', project_dir: projectDir, url: existingProcess.url });
        return { process: existingProcess, client: existingClient };
      }
    }

    log.info(`Creating new process`, { operation: 'manager_create', project_dir: projectDir, active_processes: this.processes.size });

    const newProcess = new OpenCodeProcess(projectDir);
    log.debug(`Waiting for process to be ready...`, { operation: 'manager_wait' });
    await newProcess.waitForReady();
    log.info(`Process ready`, { operation: 'manager_ready', url: newProcess.url });

    const client = new OpenCodeClient({
      baseUrl: newProcess.url,
      directory: projectDir,
    });

    this.processes.set(projectDir, newProcess);
    this.clients.set(projectDir, client);
    this.externalDirs.delete(projectDir);

    log.info(`Process registered`, { operation: 'manager_register', total_active: this.processes.size });
    return { process: newProcess, client };
  }

  getOrCreateExternal(
    projectDir: string,
    baseUrl: string,
    opts?: { extraHeaders?: Record<string, string>; auth?: OpenCodeClientAuth }
  ): { client: OpenCodeClient } {
    const existingClient = this.clients.get(projectDir);
    if (existingClient && this.externalDirs.has(projectDir)) {
      log.info(`Reusing existing external client`, { operation: 'manager_external_reuse', project_dir: projectDir, url: baseUrl });
      return { client: existingClient };
    }

    log.info(`Creating external client`, { operation: 'manager_external_create', project_dir: projectDir, url: baseUrl });
    const client = new OpenCodeClient({
      baseUrl,
      directory: projectDir,
      extraHeaders: opts?.extraHeaders,
      auth: opts?.auth,
    });

    this.clients.set(projectDir, client);
    this.externalDirs.add(projectDir);
    // Ensure no local process is associated with this dir
    const existingProcess = this.processes.get(projectDir);
    if (existingProcess) {
      existingProcess.close();
      this.processes.delete(projectDir);
    }

    return { client };
  }

  shutdown(projectDir: string): void {
    const process = this.processes.get(projectDir);
    if (process) {
      log.info(`Shutting down process`, { operation: 'manager_shutdown', project_dir: projectDir });
      process.close();
      this.processes.delete(projectDir);
    }
    this.clients.delete(projectDir);
    this.externalDirs.delete(projectDir);
  }

  isManagedProcess(projectDir: string): boolean {
    return this.processes.has(projectDir);
  }

  shutdownAll(): void {
    log.info(`Shutting down all processes`, { operation: 'manager_shutdown_all', process_count: this.processes.size });
    for (const [dir, process] of this.processes.entries()) {
      log.debug(`Stopping process`, { operation: 'manager_shutdown', project_dir: dir });
      process.close();
    }
    this.processes.clear();
    this.clients.clear();
    this.externalDirs.clear();
    log.info(`All processes stopped`, { operation: 'manager_shutdown_all' });
  }
}

export const OpenCodeManager = new OpenCodeManagerImpl();
