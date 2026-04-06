import type {
  StartPipelineRequest,
  StartPipelineResponse,
  StageOutputResponse,
  MessageInfo,
  ModelInfo,
} from '../../shared/types.js';

export function getAgentUrl(): string {
  return process.env.DEFAULT_AGENT_URL || 'http://localhost:2080';
}

export class AgentClient {
  private baseUrl: string;

  constructor(agentUrl: string) {
    this.baseUrl = agentUrl.replace(/\/$/, '');
  }

  async attachPipeline(params: {
    sessionId: string;
    dataPlaneSessionId: string;
    workspaceDir: string;
    projectDir: string;
    runtimeConfig?: string;
  }): Promise<{ attached: boolean; error?: string }> {
    const response = await fetch(`${this.baseUrl}/pipeline/${encodeURIComponent(params.sessionId)}/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent attachPipeline error: ${response.status} ${text}`);
    }
    return (await response.json()) as { attached: boolean; error?: string };
  }

  async startPipeline(params: StartPipelineRequest & { runtimeConfig?: string }): Promise<StartPipelineResponse> {
    const response = await fetch(`${this.baseUrl}/pipeline/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent startPipeline error: ${response.status} ${text}`);
    }
    return (await response.json()) as StartPipelineResponse;
  }

  async stopPipeline(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/pipeline/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
    });
  }

  async getStageOutput(sessionId: string, stage: string): Promise<StageOutputResponse | null> {
    const response = await fetch(
      `${this.baseUrl}/output/${encodeURIComponent(stage)}?sessionId=${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) return null;
    return (await response.json()) as StageOutputResponse;
  }

  async getMessages(sessionId: string): Promise<MessageInfo[]> {
    const response = await fetch(
      `${this.baseUrl}/messages?sessionId=${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent getMessages error: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { messages: MessageInfo[] };
    return data.messages || [];
  }

  async getPipelineStatus(sessionId: string): Promise<{ running: boolean }> {
    const response = await fetch(
      `${this.baseUrl}/pipeline/${encodeURIComponent(sessionId)}/status`
    );
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent getPipelineStatus error: ${response.status} ${text}`);
    }
    return (await response.json()) as { running: boolean };
  }

  async getModels(): Promise<{ models: ModelInfo[]; default: string }> {
    const response = await fetch(`${this.baseUrl}/models`);
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent getModels error: ${response.status} ${text}`);
    }
    return (await response.json()) as { models: ModelInfo[]; default: string };
  }

  async healthCheck(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Agent health check failed: ${response.status}`);
    }
    return (await response.json()) as { status: string };
  }
}
