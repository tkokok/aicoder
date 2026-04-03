/**
 * OpenCode SDK Client
 * 
 * HTTP API client for integrating with OpenCode server.
 * Provides session management, agent registration, and event subscription.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface OpenCodeConfig {
  baseUrl: string;
  directory?: string;
  timeout?: number;
}

export interface AgentFrontmatter {
  description?: string;
  mode: 'primary' | 'subagent';
  model?: string;
}

export interface Agent {
  name: string;
  path: string;
  frontmatter: AgentFrontmatter;
  content: string;
}

export interface Session {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
  completedAt?: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface PromptOptions {
  sessionId: string;
  parts: PromptPart[];
}

export type PromptPart = 
  | { type: 'text'; text: string }
  | { type: 'file'; url: string; mime?: string };

export interface EventSubscription {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeError extends Error {
  code: string;
  statusCode?: number;
  isRetryable: boolean;
}

// ============================================================================
// Error Handling
// ============================================================================

function createOpenCodeError(message: string, statusCode?: number): OpenCodeError {
  const error = new Error(message) as OpenCodeError;
  error.code = statusCode ? `HTTP_${statusCode}` : 'UNKNOWN';
  error.statusCode = statusCode;
  error.isRetryable = statusCode ? statusCode >= 500 || statusCode === 429 : false;
  return error;
}

// ============================================================================
// Agent Parser
// ============================================================================

export function parseFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: { mode: 'subagent' }, body: content };
  }
  
  const frontmatterStr = match[1];
  const body = match[2];
  
  // Parse simple YAML key-value pairs
  const frontmatter: Record<string, string> = {};
  const lines = frontmatterStr.split('\n');
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }
  
  return {
    frontmatter: {
      description: frontmatter.description,
      mode: (frontmatter.mode as 'primary' | 'subagent') || 'subagent',
      model: frontmatter.model,
    },
    body,
  };
}

/**
 * Load all agent definitions from the agents directory
 */
export async function loadAgents(agentsDir: string): Promise<Agent[]> {
  const agents: Agent[] = [];
  
  try {
    const files = await readdir(agentsDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    
    for (const file of mdFiles) {
      const filePath = join(agentsDir, file);
      const content = await readFile(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      
      const agentName = file.replace('.md', '');
      
      agents.push({
        name: agentName,
        path: filePath,
        frontmatter,
        content: body,
      });
    }
  } catch (error) {
    // Directory doesn't exist or other error - return empty array
    console.warn(`Failed to load agents from ${agentsDir}:`, error);
  }
  
  return agents;
}

// ============================================================================
// HTTP Client
// ============================================================================

class HttpClient {
  private baseUrl: string;
  private directory?: string;
  private timeout: number;
  
  constructor(config: OpenCodeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.directory = config.directory;
    this.timeout = config.timeout || 30000;
  }
  
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.directory) {
      headers['x-opencode-directory'] = encodeURIComponent(this.directory);
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw createOpenCodeError(
          `OpenCode API error: ${response.status} ${response.statusText} - ${errorText}`,
          response.status
        );
      }
      
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw createOpenCodeError('Request timeout', 408);
        }
        throw error;
      }
      
      throw createOpenCodeError('Unknown error');
    }
  }
  
  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  
  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
  
  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
}

// ============================================================================
// OpenCode Client
// ============================================================================

export class OpenCodeClient {
  private http: HttpClient;
  private config: OpenCodeConfig;
  private agents: Agent[] = [];
  
  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.http = new HttpClient(config);
  }
  
  /**
   * Initialize the client and load agents
   */
  async initialize(agentsDir?: string): Promise<void> {
    const dir = agentsDir || join(process.cwd(), 'agents');
    this.agents = await loadAgents(dir);
  }
  
  /**
   * Get all loaded agents
   */
  getAgents(): Agent[] {
    return this.agents;
  }
  
  /**
   * Get agent by name
   */
  getAgent(name: string): Agent | undefined {
    return this.agents.find(a => a.name === name);
  }
  
  // ===========================================================================
  // Session Management
  // ===========================================================================
  
  /**
   * Create a new session
   */
  async createSession(): Promise<{ data: Session }> {
    const response = await this.http.post<{ data: { id: string } }>('/session');
    return {
      data: {
        id: response.data.id,
        status: 'pending',
        createdAt: Date.now(),
      },
    };
  }
  
  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<{ data: Session }> {
    const response = await this.http.get<{ data: { id: string; status?: string } }>(`/session/${sessionId}`);
    return {
      data: {
        id: response.data.id,
        status: (response.data.status as Session['status']) || 'pending',
        createdAt: Date.now(),
      },
    };
  }
  
  /**
   * List all sessions
   */
  async listSessions(): Promise<{ data: Session[] }> {
    const response = await this.http.get<{ data: Array<{ id: string; status?: string }> }>('/session');
    return {
      data: response.data.map(s => ({
        id: s.id,
        status: (s.status as Session['status']) || 'pending',
        createdAt: Date.now(),
      })),
    };
  }
  
  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.http.delete(`/session/${sessionId}`);
  }
  
  // ===========================================================================
  // Messaging
  // ===========================================================================
  
  /**
   * Send a prompt to a session
   */
  async prompt(options: PromptOptions): Promise<{ data: { id: string } }> {
    const response = await this.http.post<{ data: { id: string } }>(
      `/session/${options.sessionId}/message`,
      {
        parts: options.parts,
      }
    );
    return response;
  }
  
  /**
   * Send a prompt asynchronously (returns immediately)
   */
  async promptAsync(options: PromptOptions): Promise<{ data: { id: string } }> {
    const response = await this.http.post<{ data: { id: string } }>(
      `/session/${options.sessionId}/prompt_async`,
      {
        parts: options.parts,
      }
    );
    return response;
  }
  
  /**
   * Get messages for a session
   */
  async getMessages(sessionId: string): Promise<{ data: Message[] }> {
    const response = await this.http.get<{ data: Array<{
      id: string;
      sessionID: string;
      role: 'user' | 'assistant';
      time: { created: number };
    }> }>(`/session/${sessionId}/message`);
    
    return {
      data: response.data.map(m => ({
        id: m.id,
        sessionId: m.sessionID,
        role: m.role,
        content: '', // Content needs to be fetched separately or from parts
        createdAt: m.time.created,
      })),
    };
  }
  
  // ===========================================================================
  // Events
  // ===========================================================================
  
  /**
   * Subscribe to events via Server-Sent Events (SSE)
   */
  subscribeEvents(onEvent: (event: EventSubscription) => void): () => void {
    const url = new URL(`${this.config.baseUrl}/event`);
    
    if (this.config.directory) {
      url.searchParams.set('directory', this.config.directory);
    }
    
    const eventSource = new EventSource(url.toString());
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
      } catch {
        console.warn('Failed to parse event data:', event.data);
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('EventSource error:', error);
    };
    
    // Return unsubscribe function
    return () => {
      eventSource.close();
    };
  }
  
  // ===========================================================================
  // Health Check
  // ===========================================================================
  
  /**
   * Check if OpenCode server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get('/config');
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get server configuration
   */
  async getConfig(): Promise<Record<string, unknown>> {
    return this.http.get('/config');
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an OpenCode client instance
 */
export function createOpenCodeClient(config?: Partial<OpenCodeConfig>): OpenCodeClient {
  const defaultConfig: OpenCodeConfig = {
    baseUrl: process.env.OPENCODE_URL || 'http://localhost:8080',
    directory: process.env.OPENCODE_DIRECTORY || process.cwd(),
    timeout: 30000,
  };
  
  return new OpenCodeClient({ ...defaultConfig, ...config });
}

// ============================================================================
// Default Export
// ============================================================================

export default OpenCodeClient;