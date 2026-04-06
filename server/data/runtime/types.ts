/**
 * AgentRuntime abstraction for the data plane.
 * All runtime-specific logic (OpenCode, future kimi-cli, etc.) is encapsulated behind this interface.
 */

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; url: string; mime?: string; filename?: string };

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

export interface ModelInfo {
  id: string;
  name: string;
  providerID: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

export interface AgentRuntime {
  /** Prepare the project directory for this runtime (agents, schemas, frontmatter, etc.) */
  prepareEnvironment(projectDir: string, config: {
    mainModel: string;
    subagentModel: string;
    reasoningEffort?: string;
  }): Promise<void>;

  /** Create a new session on the runtime */
  createSession(opts?: { title?: string; parentID?: string }): Promise<SessionInfo>;

  /** Send a message/prompt to a session */
  sendMessage(
    sessionId: string,
    parts: PromptPart[],
    opts?: { agent?: string; model?: string; noReply?: boolean; reasoningEffort?: string }
  ): Promise<void>;

  /** Get messages for a session */
  getMessages(sessionId: string): Promise<MessageInfo[]>;

  /** Get available models from the runtime */
  getModels(): Promise<ModelInfo[]>;

  /** Subscribe to runtime events (SSE or equivalent) */
  subscribeEvents(onEvent: (event: SSEEvent) => void): () => void;

  /** Shutdown any runtime-managed resources for a project directory */
  shutdown(projectDir?: string): void;
}
