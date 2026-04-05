/**
 * OpenCode Process Manager + HTTP Client
 *
 * Manages OpenCode server subprocesses and provides HTTP API client.
 * Each project gets its own OpenCode process on a random port (20000-30000).
 */

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

const log = {
  info: (component: string, msg: string, data?: unknown) => {
    const ts = new Date().toISOString();
    if (data !== undefined) {
      console.log(`[${ts}] [opencode:${component}] ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data);
    } else {
      console.log(`[${ts}] [opencode:${component}] ${msg}`);
    }
  },
  error: (component: string, msg: string, data?: unknown) => {
    const ts = new Date().toISOString();
    if (data !== undefined) {
      console.error(`[${ts}] [opencode:${component}] ERROR: ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data);
    } else {
      console.error(`[${ts}] [opencode:${component}] ERROR: ${msg}`);
    }
  },
};

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
    log.info('process', `Allocated port ${this.port} for project: ${projectDir}`);
    this.spawn();
  }

  private spawn(): void {
    const binaryPath = process.env.OPENCODE_BIN_PATH || `${process.env.HOME}/.opencode/bin/opencode`;
    const command = `${binaryPath} serve --port ${this.port} --hostname ${this.hostname}`;
    // Use bash -lc to load shell environment variables (e.g. from .bashrc / .bash_profile)
    const args = ['bash', '-lc', command];
    log.info('process', `Spawning: ${args.join(' ')}`);
    log.info('process', `Working directory: ${this.projectDir}`);

    this.process = Bun.spawn(args, {
      cwd: this.projectDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });

    log.info('process', `Subprocess PID: ${this.process.pid}`);

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
          log.error('process:stderr', text.trim());
        }
      };
      readStderr().catch(() => {});
    }

    const readOutput = async () => {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.error('process', `stdout stream ended (process may have exited)`);
          break;
        }

        const text = decoder.decode(value);
        log.info('process:stdout', text.trim());

        const match = text.match(/opencode server listening on http:\/\/([^:]+):(\d+)/);
        if (match) {
          log.info('process', `✓ OpenCode server ready at http://${match[1]}:${match[2]}`);
          this.readyResolve();
          return;
        }
      }
    };

    readOutput().catch((error) => {
      log.error('process', `Failed to read stdout: ${error}`);
      this.readyReject(new Error(`Failed to read stdout: ${error}`));
    });

    const timeout = setTimeout(() => {
      log.error('process', `Timeout (5s) waiting for server on port ${this.port}`);
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
      log.info('process', `Killing OpenCode process (PID: ${this.process.pid}, port: ${this.port})`);
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
    log.info('client', `Created client → ${this.baseUrl}, dir=${this.directory}, hasAuth=${!!this.auth}, hasExtraHeaders=${Object.keys(this.extraHeaders).length > 0}`);
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

    log.info('client', `→ ${method} ${url}`);
    if (body) {
      log.info('client', `  body: ${JSON.stringify(body).slice(0, 500)}`);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    log.info('client', `← ${response.status} ${response.statusText} ${method} ${path}`);

    if (!response.ok) {
      const errorText = await response.text();
      log.error('client', `  response body: ${errorText.slice(0, 500)}`);
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      log.info('client', `  (204 No Content)`);
      return undefined as T;
    }

    const json = await response.json();
    log.info('client', `  response: ${JSON.stringify(json).slice(0, 500)}`);
    return json;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/global/health`;
      log.info('client', `Health check → GET ${url}`);
      const response = await fetch(url, {
        headers: this.buildHeaders(),
      });
      const ok = response.status === 200;
      log.info('client', `Health check result: ${ok} (${response.status})`);
      return ok;
    } catch (error) {
      log.error('client', `Health check failed: ${error}`);
      return false;
    }
  }

  async createSession(opts?: { title?: string; parentID?: string }): Promise<SessionInfo> {
    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    if (opts?.parentID) body.parentID = opts.parentID;
    log.info('client', `Creating session with title: ${opts?.title || '(default)'} parentID: ${opts?.parentID || '(none)'}`);
    const session = await this.request<SessionInfo>('POST', '/session', body);
    log.info('client', `Session created: id=${session.id}, title=${session.title}`);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    log.info('client', `Getting session: ${sessionId}`);
    return this.request<SessionInfo>('GET', `/session/${sessionId}`);
  }

  async archiveSession(sessionId: string): Promise<void> {
    log.info('client', `Archiving session: ${sessionId}`);
    try {
      await this.request<SessionInfo>('PATCH', `/session/${sessionId}`, {
        time: { archived: Date.now() },
      });
      log.info('client', `Session archived: ${sessionId}`);
    } catch (error) {
      log.error('client', `Failed to archive session ${sessionId}: ${error}`);
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
    opts?: { agent?: string; model?: string }
  ): Promise<void> {
    const body: { parts: PromptPart[]; agent?: string; model?: { providerID: string; modelID: string } } = { parts };
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
    const textParts = parts.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text.slice(0, 100));
    log.info('client', `Sending message to session ${sessionId}, agent=${opts?.agent || 'default'}`);
    log.info('client', `  parts preview: ${JSON.stringify(textParts)}`);
    await this.request<void>('POST', `/session/${sessionId}/prompt_async`, body);
    log.info('client', `Message sent (async, fire-and-forget)`);
  }

  async getMessages(sessionId: string): Promise<MessageInfo[]> {
    log.info('client', `Fetching messages for session ${sessionId}`);
    const raw = await this.request<any[]>('GET', `/session/${sessionId}/message`);
    log.info('client', `Got ${raw.length} raw messages`);
    const lastAssistant = raw.filter((m: any) => m.info?.role === 'assistant').slice(-1)[0];
    if (lastAssistant) {
      log.info('client', `Last assistant: finish=${lastAssistant.info?.finish}, parts=${lastAssistant.parts?.length}`);
    }

    const mapped: MessageInfo[] = raw.map((m) => ({
      id: m.info?.id ?? m.id ?? '',
      sessionID: m.info?.sessionID ?? m.sessionID ?? '',
      role: m.info?.role ?? m.role ?? 'user',
      parts: (m.parts ?? []) as MessagePart[],
      finish: m.info?.finish ?? undefined,
      time: m.info?.time ?? m.time ?? { created: 0 },
    }));

    return mapped;
  }

  async getModels(): Promise<ModelInfo[]> {
    log.info('client', `Fetching available models from /provider`);
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
    log.info('client', `Found ${models.length} models from ${connectedSet.size} connected providers`);
    return models;
  }

  subscribeEvents(onEvent: (event: SSEEvent) => void): () => void {
    let aborted = false;
    const url = `${this.baseUrl}/event`;

    log.info('sse', `Connecting to SSE: ${url}`);

    const connect = async () => {
      try {
        const response = await fetch(url, {
          headers: this.buildHeaders(),
        });

        if (!response.ok) {
          log.error('sse', `Connection failed: ${response.status}`);
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        log.info('sse', `Connected, reading stream...`);

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) {
            log.info('sse', `Stream ended`);
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
                  log.info('sse', `Event: ${data.type}`);
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
          log.error('sse', `Connection error: ${error}`);
        }
      }
    };

    connect();

    return () => {
      log.info('sse', `Unsubscribing`);
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
        log.info('manager', `Reusing existing process for: ${projectDir} (url=${existingProcess.url})`);
        return { process: existingProcess, client: existingClient };
      }
    }

    log.info('manager', `No existing process for: ${projectDir}`);
    log.info('manager', `Active processes: ${this.processes.size}`);

    const newProcess = new OpenCodeProcess(projectDir);
    log.info('manager', `Waiting for process to be ready...`);
    await newProcess.waitForReady();
    log.info('manager', `Process ready at ${newProcess.url}`);

    const client = new OpenCodeClient({
      baseUrl: newProcess.url,
      directory: projectDir,
    });

    this.processes.set(projectDir, newProcess);
    this.clients.set(projectDir, client);
    this.externalDirs.delete(projectDir);

    log.info('manager', `Process registered. Total active: ${this.processes.size}`);
    return { process: newProcess, client };
  }

  getOrCreateExternal(
    projectDir: string,
    baseUrl: string,
    opts?: { extraHeaders?: Record<string, string>; auth?: OpenCodeClientAuth }
  ): { client: OpenCodeClient } {
    const existingClient = this.clients.get(projectDir);
    if (existingClient && this.externalDirs.has(projectDir)) {
      log.info('manager', `Reusing existing external client for: ${projectDir} (url=${baseUrl})`);
      return { client: existingClient };
    }

    log.info('manager', `Creating external client for: ${projectDir} (url=${baseUrl})`);
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
      log.info('manager', `Shutting down process for: ${projectDir}`);
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
    log.info('manager', `Shutting down all ${this.processes.size} processes`);
    for (const [dir, process] of this.processes.entries()) {
      log.info('manager', `  Stopping: ${dir}`);
      process.close();
    }
    this.processes.clear();
    this.clients.clear();
    this.externalDirs.clear();
    log.info('manager', `All processes stopped`);
  }
}

export const OpenCodeManager = new OpenCodeManagerImpl();
