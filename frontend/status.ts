/**
 * Status Page WebSocket Client + HTTP Polling Fallback
 *
 * Handles real-time pipeline status updates via WebSocket,
 * with HTTP polling as a fallback for opencode_url, current_agent, and latest_message.
 */

type PipelineStage = 'clarify' | 'design' | 'task' | 'dev' | 'test' | 'review' | 'validate';
type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface StageResult {
  status: StageStatus;
  attempts: number;
  output?: string;
  error?: string;
}

interface PipelineStatus {
  session_id: string;
  pipeline: {
    current_stage: PipelineStage | 'completed' | 'failed';
    started_at: string;
    updated_at: string;
  };
  stages: Record<PipelineStage, StageResult>;
  errors: Array<{
    stage: PipelineStage;
    message: string;
    timestamp: string;
    recoverable: boolean;
  }>;
}

interface WebSocketMessage {
  event: string;
  data: Record<string, unknown>;
}

const STAGE_ORDER: PipelineStage[] = [
  'clarify',
  'design',
  'task',
  'dev',
  'test',
  'review',
  'validate',
];

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const POLL_INTERVAL = 3000;

class StatusPage {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private currentStatus: PipelineStatus | null = null;
  private pollTimer: number | null = null;
  private opencodeUrl: string | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.sessionId = this.getSessionIdFromUrl();
    if (this.sessionId) {
      this.updateSessionDisplay(this.sessionId);
      this.startPolling();
    }
    this.connectWebSocket();
  }

  private getSessionIdFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('session');
  }

  private updateSessionDisplay(sessionId: string): void {
    const sessionIdEl = document.getElementById('session-id');
    if (sessionIdEl) {
      sessionIdEl.textContent = sessionId;
    }
  }

  private startPolling(): void {
    this.fetchSessionStatus();
    this.pollTimer = window.setInterval(() => this.fetchSessionStatus(), POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchSessionStatus(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}`);
      if (!response.ok) return;
      const data = (await response.json()) as Record<string, unknown>;

      if (typeof data.opencode_url === 'string' && data.opencode_url) {
        this.opencodeUrl = data.opencode_url;
        this.updateOpenCodeUrl(data.opencode_url);
      }

      if (typeof data.project_path === 'string' && data.project_path) {
        this.updateProjectPath(data.project_path);
      }

      const currentAgent = typeof data.current_agent === 'string' ? data.current_agent : undefined;
      const latestMessage = typeof data.latest_message === 'string' ? data.latest_message : undefined;
      const status = typeof data.status === 'string' ? data.status : 'pending';

      if (currentAgent) {
        this.updateCurrentAgent(currentAgent);
      }
      if (latestMessage !== undefined) {
        this.updateLatestMessage(latestMessage || 'Waiting for updates...');
      }

      // Render persisted stages snapshot if available
      if (data.stages && typeof data.stages === 'object' && data.stages !== null) {
        const stages = data.stages as Record<string, { status?: string }>;
        for (const stage of STAGE_ORDER) {
          const stageData = stages[stage];
          if (stageData?.status) {
            this.updateStageIndicator(stage, stageData.status as StageStatus);
          } else {
            this.updateStageIndicator(stage, 'pending');
          }
        }
      }

      // Derive progress from current_agent / status if we don't have a full PipelineStatus yet
      if (status === 'completed') {
        this.updateProgress(100, 'Completed');
        if (!data.stages) {
          this.updateAllStagesCompleted();
        }
      } else if (status === 'failed') {
        this.updateProgress(0, 'Failed');
      } else if (currentAgent && currentAgent !== 'completed') {
        const agentStage = currentAgent.replace(' agent', '') as PipelineStage | 'completed';
        if (STAGE_ORDER.includes(agentStage as PipelineStage)) {
          const stageIndex = STAGE_ORDER.indexOf(agentStage as PipelineStage);
          const progress = Math.round((stageIndex / STAGE_ORDER.length) * 100);
          this.updateProgress(progress, this.formatStageName(agentStage as PipelineStage));
          // If no stages snapshot from DB, mark previous stages completed, current running
          if (!data.stages) {
            for (let i = 0; i < STAGE_ORDER.length; i++) {
              if (i < stageIndex) {
                this.updateStageIndicator(STAGE_ORDER[i], 'completed');
              } else if (i === stageIndex) {
                this.updateStageIndicator(STAGE_ORDER[i], 'running');
              } else {
                this.updateStageIndicator(STAGE_ORDER[i], 'pending');
              }
            }
          }
        }
      }
    } catch (err) {
      // ignore polling errors
    }
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.updateConnectionStatus('connected');

        if (this.sessionId) {
          this.ws?.send(JSON.stringify({
            type: 'subscribe',
            session: this.sessionId,
          }));
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
        this.updateConnectionStatus('error');
      };

      this.ws.onclose = () => {
        this.updateConnectionStatus('disconnected');
        this.scheduleReconnect();
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      setTimeout(() => this.connectWebSocket(), RECONNECT_DELAY);
    } else {
      console.error('Max reconnection attempts reached');
      this.showError('Connection lost. Please refresh the page.');
    }
  }

  private updateConnectionStatus(status: 'connected' | 'disconnected' | 'error'): void {
    const statusBadge = document.getElementById('session-status');
    if (!statusBadge) return;

    statusBadge.classList.remove('pending', 'running', 'completed', 'failed');

    switch (status) {
      case 'connected':
        statusBadge.textContent = 'Connected';
        statusBadge.classList.add('running');
        break;
      case 'disconnected':
        statusBadge.textContent = 'Disconnected';
        statusBadge.classList.add('pending');
        break;
      case 'error':
        statusBadge.textContent = 'Connection Error';
        statusBadge.classList.add('failed');
        break;
    }
  }

  private isCurrentSession(data: Record<string, unknown>): boolean {
    return typeof data.session_id === 'string' && data.session_id === this.sessionId;
  }

  private handleMessage(message: WebSocketMessage): void {
    switch (message.event) {
      case 'connected':
        break;

      case 'pong':
        break;

      case 'progress':
        if (this.isCurrentSession(message.data)) {
          this.handleProgressUpdate(message.data);
        }
        break;

      case 'stage_update':
        if (this.isCurrentSession(message.data)) {
          this.handleStageUpdate(message.data as { stage: PipelineStage; status: StageStatus });
        }
        break;

      case 'completed':
        if (this.isCurrentSession(message.data)) {
          this.handleCompletion(message.data as { session_id: string });
        }
        break;

      case 'failed':
        if (this.isCurrentSession(message.data)) {
          this.handleFailure(message.data as { stage: PipelineStage; error: string });
        }
        break;

      default:
        break;
    }
  }

  private handleProgressUpdate(data: Record<string, unknown>): void {
    // Full PipelineStatus from legacy flow
    if (data.stages && data.pipeline) {
      this.currentStatus = data as unknown as PipelineStatus;
      this.updateUI(this.currentStatus);
    }

    // Simplified progress from our new polling
    const currentStage = typeof data.current_stage === 'string' ? data.current_stage : undefined;
    const currentAgent = typeof data.current_agent === 'string' ? data.current_agent : undefined;
    const latestMessage = typeof data.latest_message === 'string' ? data.latest_message : undefined;
    const progressPercent = typeof data.progress_percent === 'number' ? data.progress_percent : undefined;

    if (currentAgent) {
      this.updateCurrentAgent(currentAgent);
    }
    if (latestMessage !== undefined) {
      this.updateLatestMessage(latestMessage || 'Waiting for updates...');
    }
    if (currentStage && progressPercent !== undefined) {
      const label = currentStage === 'completed' ? 'Completed' : this.formatStageName(currentStage as PipelineStage);
      this.updateProgress(progressPercent, label);
    }

    // Update stage indicators from explicit stages snapshot if provided
    if (data.stages && typeof data.stages === 'object' && data.stages !== null && !data.pipeline) {
      const stages = data.stages as Record<string, { status?: string }>;
      for (const stage of STAGE_ORDER) {
        const stageData = stages[stage];
        this.updateStageIndicator(stage, (stageData?.status as StageStatus) || 'pending');
      }
    } else if (currentStage && progressPercent !== undefined && !data.stages) {
      // Fallback: infer from current_stage
      if (currentStage !== 'completed' && currentStage !== 'failed' && STAGE_ORDER.includes(currentStage as PipelineStage)) {
        const idx = STAGE_ORDER.indexOf(currentStage as PipelineStage);
        for (let i = 0; i < STAGE_ORDER.length; i++) {
          if (i < idx) this.updateStageIndicator(STAGE_ORDER[i], 'completed');
          else if (i === idx) this.updateStageIndicator(STAGE_ORDER[i], 'running');
          else this.updateStageIndicator(STAGE_ORDER[i], 'pending');
        }
      }
    }
  }

  private handleStageUpdate(data: { stage: PipelineStage; status: StageStatus }): void {
    this.updateStageIndicator(data.stage, data.status);

    if (data.status === 'running') {
      this.updateProgressStage(data.stage);
    }
  }

  private handleCompletion(data: { session_id: string }): void {
    this.updateConnectionStatus('connected');
    this.updateAllStagesCompleted();
    this.updateProgress(100, 'Completed');
    this.updateCurrentAgent('completed');
    this.stopPolling();

    setTimeout(() => {
      window.location.href = `report.html?session=${data.session_id}`;
    }, 2000);
  }

  private handleFailure(data: { stage: PipelineStage; error: string }): void {
    this.updateStageIndicator(data.stage, 'failed');
    this.showError(`Pipeline failed at stage "${data.stage}": ${data.error}`);
    this.stopPolling();
  }

  private updateUI(status: PipelineStatus): void {
    this.updateProgressFromStatus(status);
    this.updateAllStages(status);
  }

  private updateProgressFromStatus(status: PipelineStatus): void {
    const currentStage = status.pipeline.current_stage;

    if (currentStage === 'completed') {
      this.updateProgress(100, 'Completed');
      return;
    }

    if (currentStage === 'failed') {
      this.updateProgress(0, 'Failed');
      return;
    }

    const stageIndex = STAGE_ORDER.indexOf(currentStage);
    const totalStages = STAGE_ORDER.length;
    const progress = Math.round(((stageIndex) / totalStages) * 100);

    this.updateProgress(progress, this.formatStageName(currentStage));
  }

  private updateProgress(percent: number, stage: string): void {
    const progressFill = document.getElementById('progress-fill');
    const progressPercent = document.getElementById('progress-percent');
    const progressStage = document.getElementById('progress-stage');

    if (progressFill) {
      progressFill.style.width = `${percent}%`;
    }

    if (progressPercent) {
      progressPercent.textContent = `${percent}%`;
    }

    if (progressStage) {
      progressStage.textContent = stage;
    }
  }

  private updateProgressStage(stage: PipelineStage): void {
    const progressStage = document.getElementById('progress-stage');
    if (progressStage) {
      progressStage.textContent = this.formatStageName(stage);
    }
  }

  private updateCurrentAgent(agent: string): void {
    // Show agent info near progress or in a dedicated element if desired
    // For now, append to progress stage text
    const progressStage = document.getElementById('progress-stage');
    if (progressStage && agent && agent !== 'completed' && agent !== 'failed') {
      const base = progressStage.textContent?.replace(/ \(.+\)$/, '') || '';
      progressStage.textContent = `${base} (${agent})`;
    }
  }

  private updateLatestMessage(text: string): void {
    const el = document.getElementById('latest-message');
    if (el) {
      el.textContent = text;
    }
  }

  private updateOpenCodeUrl(url: string): void {
    const el = document.getElementById('opencode-url') as HTMLAnchorElement | null;
    if (el) {
      el.href = url;
      el.textContent = url;
    }
  }

  private updateProjectPath(path: string): void {
    const el = document.getElementById('project-path');
    if (el) {
      el.textContent = path;
    }
    const copyBtn = document.getElementById('copy-path-btn') as HTMLButtonElement | null;
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(path).then(() => {
          const original = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = original;
          }, 1500);
        }).catch(() => {
          // Fallback for older browsers or denied permission
          const textArea = document.createElement('textarea');
          textArea.value = path;
          document.body.appendChild(textArea);
          textArea.select();
          try {
            document.execCommand('copy');
            const original = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyBtn.textContent = original;
            }, 1500);
          } catch {
            // ignore
          }
          document.body.removeChild(textArea);
        });
      };
    }
  }

  private updateAllStages(status: PipelineStatus): void {
    for (const stage of STAGE_ORDER) {
      const stageResult = status.stages[stage];
      if (stageResult) {
        this.updateStageIndicator(stage, stageResult.status);
      }
    }
  }

  private updateStageIndicator(stage: PipelineStage, status: StageStatus): void {
    const step = document.querySelector(`.progress-step[data-stage="${stage}"]`);
    if (!step) return;

    const dot = step.querySelector('[data-dot]');
    if (dot) {
      dot.classList.remove('pending', 'running', 'completed', 'failed');
      dot.classList.add(status);
    }
  }

  private updateAllStagesCompleted(): void {
    for (const stage of STAGE_ORDER) {
      this.updateStageIndicator(stage, 'completed');
    }
  }

  private formatStageName(stage: PipelineStage): string {
    const names: Record<PipelineStage, string> = {
      clarify: 'Clarifying Requirements',
      design: 'Designing Solution',
      task: 'Planning Tasks',
      dev: 'Developing',
      test: 'Testing',
      review: 'Reviewing',
      validate: 'Validating',
    };
    return names[stage] || stage;
  }

  private getStatusText(status: StageStatus): string {
    const texts: Record<StageStatus, string> = {
      pending: 'Waiting to start',
      running: 'In progress...',
      completed: 'Completed',
      failed: 'Failed',
      skipped: 'Skipped',
    };
    return texts[status] || status;
  }

  private showError(message: string): void {
    const errorCard = document.getElementById('error-card');
    const errorMessage = document.getElementById('error-message');

    if (errorCard && errorMessage) {
      errorMessage.textContent = message;
      errorCard.classList.remove('hidden');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new StatusPage();
});
