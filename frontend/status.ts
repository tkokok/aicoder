/**
 * Status Page WebSocket Client
 * 
 * Handles real-time pipeline status updates via WebSocket connection.
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

const WS_URL = 'ws://localhost:3000/ws';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

class StatusPage {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private currentStatus: PipelineStatus | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.sessionId = this.getSessionIdFromUrl();
    if (this.sessionId) {
      this.updateSessionDisplay(this.sessionId);
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

  private handleMessage(message: WebSocketMessage): void {
    switch (message.event) {
      case 'connected':
        break;

      case 'pong':
        break;

      case 'progress':
        this.handleProgressUpdate(message.data as unknown as PipelineStatus);
        break;

      case 'stage_update':
        this.handleStageUpdate(message.data as { stage: PipelineStage; status: StageStatus });
        break;

      case 'completed':
        this.handleCompletion(message.data as { session_id: string });
        break;

      case 'failed':
        this.handleFailure(message.data as { stage: PipelineStage; error: string });
        break;

      default:
        break;
    }
  }

  private handleProgressUpdate(status: PipelineStatus): void {
    this.currentStatus = status;
    this.updateUI(status);
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
    
    setTimeout(() => {
      window.location.href = `report.html?session=${data.session_id}`;
    }, 2000);
  }

  private handleFailure(data: { stage: PipelineStage; error: string }): void {
    this.updateStageIndicator(data.stage, 'failed');
    this.showError(`Pipeline failed at stage "${data.stage}": ${data.error}`);
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

  private updateAllStages(status: PipelineStatus): void {
    for (const stage of STAGE_ORDER) {
      const stageResult = status.stages[stage];
      if (stageResult) {
        this.updateStageIndicator(stage, stageResult.status);
      }
    }
  }

  private updateStageIndicator(stage: PipelineStage, status: StageStatus): void {
    const stageItem = document.querySelector(`[data-stage="${stage}"]`);
    if (!stageItem) return;

    const indicator = stageItem.querySelector('.stage-indicator');
    const statusText = stageItem.querySelector('.stage-status');

    if (indicator) {
      indicator.classList.remove('pending', 'running', 'completed', 'failed');
      indicator.classList.add(status);
    }

    if (statusText) {
      statusText.classList.remove('pending', 'running', 'completed', 'failed');
      statusText.classList.add(status);
      statusText.textContent = this.getStatusText(status);
    }

    stageItem.classList.remove('active', 'completed');
    if (status === 'running') {
      stageItem.classList.add('active');
    } else if (status === 'completed' || status === 'skipped') {
      stageItem.classList.add('completed');
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