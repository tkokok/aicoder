/**
 * Status Page WebSocket Client + HTTP Polling Fallback
 */

interface WebSocketMessage {
  event: string;
  data: Record<string, unknown>;
}

const WS_URL = `ws://${window.location.host}/ws`;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const POLL_INTERVAL = 3000;

class StatusPage {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private sessionId: string | null = null;
  private pollTimer: number | null = null;
  private runtimeUrl: string | null = null;
  private dataPlaneSessionId: string | null = null;
  private projectPath: string | null = null;
  private lastError: string | null = null;

  constructor() {
    this.init();
  }

  private showFullHistory = false;
  private currentMessages: string[] = [];

  private init(): void {
    this.sessionId = this.getSessionIdFromUrl();
    if (this.sessionId) {
      this.updateSessionDisplay(this.sessionId);
      this.startPolling();
    }
    this.connectWebSocket();

    const toggleBtn = document.getElementById('toggle-history-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.showFullHistory = !this.showFullHistory;
        toggleBtn.setAttribute('aria-expanded', String(this.showFullHistory));
        this.renderActivity();
      });
    }

    const resumeBtn = document.getElementById('resume-pipeline-btn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => this.resumePipeline());
    }

  }

  private async resumePipeline(): Promise<void> {
    const btn = document.getElementById('resume-pipeline-btn') as HTMLButtonElement | null;
    if (!btn || !this.sessionId) return;
    if (btn.disabled) return;

    const originalLabel = btn.textContent || 'Resume Pipeline';
    btn.disabled = true;
    btn.textContent = 'Resuming...';

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/resume`, {
        method: 'POST',
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = (await response.json()) as { error?: string; reason?: string };
          detail = body.reason || body.error || '';
        } catch {
          detail = `HTTP ${response.status}`;
        }
        this.showError(`Resume failed: ${detail || 'unknown error'}`);
        btn.disabled = false;
        btn.textContent = originalLabel;
        return;
      }

      // Optimistically flip UI to running; the polling loop will reconcile.
      btn.textContent = 'Resumed';
      this.updatePipelineState('Resuming', 'running');
      // Refresh immediately so the page picks up the new server-side state.
      this.fetchSessionStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showError(`Resume request failed: ${msg}`);
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
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

      if (typeof data.runtime_url === 'string' && data.runtime_url) {
        this.runtimeUrl = data.runtime_url;
        this.updateRuntimeUrl(data.runtime_url);
      }

      if (typeof data.data_plane_session_id === 'string' && data.data_plane_session_id) {
        this.dataPlaneSessionId = data.data_plane_session_id;
      }

      if (typeof data.project_path === 'string' && data.project_path) {
        this.projectPath = data.project_path;
        this.updateProjectDir(data.project_path);
      }

      this.updateMainAgentUrl();

      const workspacePath = typeof data.workspace_path === 'string' && data.workspace_path
        ? data.workspace_path
        : typeof data.project_path === 'string' && data.project_path
        ? data.project_path
        : undefined;
      if (workspacePath) {
        this.updateWorkspacePath(workspacePath);
      }

      if (typeof data.repo_name === 'string' && data.repo_name) {
        this.updateRepoName(data.repo_name);
      }

      // Cumulative token / cost usage. Read from session row populated by
      // the control-plane message-update callback.
      const tokensIn = typeof data.total_tokens_in === 'number' ? data.total_tokens_in : undefined;
      const tokensOut = typeof data.total_tokens_out === 'number' ? data.total_tokens_out : undefined;
      const tokensReasoning = typeof data.total_tokens_reasoning === 'number' ? data.total_tokens_reasoning : undefined;
      const costUsd = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined;
      if (
        tokensIn !== undefined ||
        tokensOut !== undefined ||
        tokensReasoning !== undefined ||
        costUsd !== undefined
      ) {
        this.updateUsage({ tokensIn, tokensOut, tokensReasoning, costUsd });
      }

      const status = typeof data.status === 'string' ? data.status : 'pending';
      const currentStage = typeof data.current_agent === 'string' ? data.current_agent : undefined;
      const latestMessage = typeof data.latest_message === 'string' ? data.latest_message : undefined;
      let messagesList: string[] | undefined;
      if (data.messages_json && typeof data.messages_json === 'string') {
        try {
          messagesList = JSON.parse(data.messages_json) as string[];
        } catch {}
      }

      if (messagesList !== undefined && messagesList.length > 0) {
        this.currentMessages = messagesList;
      } else if (latestMessage !== undefined) {
        this.currentMessages = [latestMessage || 'Waiting for updates...'];
      }
      this.renderActivity();

      let progressPercent: number | undefined;
      let stages: Record<string, { status?: string }> | undefined;
      if (data.stages && typeof data.stages === 'object' && data.stages !== null) {
        stages = data.stages as Record<string, { status?: string }>;
        progressPercent = this.calculateProgress(stages);
      }

      if (status === 'completed') {
        this.updatePipelineState('Completed', 'completed');
        this.updateProgress(100);
      } else if (status === 'failed') {
        const errorMsg = this.lastError || 'Pipeline failed';
        this.updatePipelineState('Failed', 'failed', errorMsg);
        this.updateProgress(0);
      } else {
        const rawStep = currentStage || 'Initializing';
        const stepName = rawStep === 'completed'
          ? 'Completed'
          : rawStep === 'failed'
          ? 'Failed'
          : rawStep.replace(' agent', '');
        this.updatePipelineState(stepName, 'running');
        if (progressPercent !== undefined) {
          this.updateProgress(progressPercent);
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
      case 'progress':
        if (this.isCurrentSession(message.data)) {
          this.handleProgressUpdate(message.data);
        }
        break;
      case 'completed':
        if (this.isCurrentSession(message.data)) {
          this.handleCompletion();
        }
        break;
      case 'failed':
        if (this.isCurrentSession(message.data)) {
          const error = typeof message.data.error === 'string' ? message.data.error : 'Unknown error';
          this.handleFailure(error);
        }
        break;
      default:
        break;
    }
  }

  private handleProgressUpdate(data: Record<string, unknown>): void {
    const currentStage = typeof data.current_stage === 'string' ? data.current_stage : undefined;
    const currentAgent = typeof data.current_agent === 'string' ? data.current_agent : undefined;
    const latestMessage = typeof data.latest_message === 'string' ? data.latest_message : undefined;
    let messagesList: string[] | undefined;
    if (data.messages_json && typeof data.messages_json === 'string') {
      try {
        messagesList = JSON.parse(data.messages_json) as string[];
      } catch {}
    }
    let progressPercent = typeof data.progress_percent === 'number' ? data.progress_percent : undefined;
    if (progressPercent === undefined && data.stages && typeof data.stages === 'object' && data.stages !== null) {
      const stages = data.stages as Record<string, { status?: string }>;
      progressPercent = this.calculateProgress(stages);
    }

    // Live token / cost update from the broadcast event. The control-plane
    // attaches the cumulative numbers under `usage`.
    const usage = data.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      this.updateUsage({
        tokensIn: typeof u.tokens_in === 'number' ? u.tokens_in : undefined,
        tokensOut: typeof u.tokens_out === 'number' ? u.tokens_out : undefined,
        tokensReasoning: typeof u.tokens_reasoning === 'number' ? u.tokens_reasoning : undefined,
        costUsd: typeof u.cost_usd === 'number' ? u.cost_usd : undefined,
      });
    }

    if (messagesList !== undefined && messagesList.length > 0) {
      this.currentMessages = messagesList;
    } else if (latestMessage !== undefined) {
      this.currentMessages = [latestMessage || 'Waiting for updates...'];
    }
    this.renderActivity();

    if (progressPercent !== undefined) {
      this.updateProgress(progressPercent);
    }

    const rawStep = currentStage || currentAgent || '-';
    const stepName = rawStep === 'completed'
      ? 'Completed'
      : rawStep === 'failed'
      ? 'Failed'
      : rawStep.replace(' agent', '');

    if (rawStep === 'completed') {
      this.updatePipelineState(stepName, 'completed');
    } else if (rawStep === 'failed') {
      this.updatePipelineState(stepName, 'failed', this.lastError || 'Pipeline failed');
    } else {
      this.updatePipelineState(stepName, 'running');
    }
  }

  private handleCompletion(): void {
    this.updateConnectionStatus('connected');
    this.updatePipelineState('Completed', 'completed');
    this.updateProgress(100);
    this.stopPolling();
    setTimeout(() => {
      if (this.sessionId) {
        window.location.href = `report.html?id=${this.sessionId}`;
      }
    }, 2000);
  }

  private handleFailure(error: string): void {
    this.lastError = error;
    this.updatePipelineState('Failed', 'failed', error);
    this.stopPolling();
  }

  private updateProgress(percent: number): void {
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
      if (percent === 100) {
        progressStage.textContent = 'Completed';
      } else if (percent === 0 && this.lastError) {
        progressStage.textContent = 'Failed';
      }
    }
  }

  private updatePipelineState(step: string, status: 'pending' | 'running' | 'completed' | 'failed', error?: string): void {
    const stepEl = document.getElementById('current-step');
    const badgeEl = document.getElementById('pipeline-status-badge');
    const errorBox = document.getElementById('pipeline-error');
    const errorText = document.getElementById('pipeline-error-text');
    const errorActions = document.getElementById('pipeline-error-actions');

    if (stepEl) {
      stepEl.textContent = step;
    }

    if (badgeEl) {
      badgeEl.classList.remove('pending', 'running', 'completed', 'failed');
      badgeEl.classList.add(status);
      const labelMap: Record<string, string> = {
        pending: 'Not started',
        running: 'In progress',
        completed: 'Completed',
        failed: 'Failed',
      };
      badgeEl.textContent = labelMap[status] || status;
    }

    if (errorBox && errorText) {
      if (status === 'failed' && error) {
        errorText.textContent = error;
        errorBox.classList.remove('hidden');
        errorActions?.classList.remove('hidden');
      } else {
        errorBox.classList.add('hidden');
        errorActions?.classList.add('hidden');
      }
    }
  }

  private renderActivity(): void {
    const contentEl = document.getElementById('activity-content');
    const toggleBtn = document.getElementById('toggle-history-btn');
    const titleEl = document.getElementById('activity-title');
    if (!contentEl) return;

    if (this.showFullHistory) {
      contentEl.innerHTML = '';
      for (const msg of this.currentMessages) {
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.textContent = msg;
        contentEl.appendChild(item);
      }
      if (toggleBtn) toggleBtn.textContent = 'Show Latest Only';
      if (titleEl) titleEl.textContent = 'Activity History';
    } else {
      const latest = this.currentMessages[this.currentMessages.length - 1] || 'Waiting for updates...';
      contentEl.textContent = latest;
      if (toggleBtn) toggleBtn.textContent = 'Show Full History';
      if (titleEl) titleEl.textContent = 'Latest Activity';
    }
  }

  private calculateProgress(stages: Record<string, { status?: string }>): number {
    const stageNames = Object.keys(stages);
    if (stageNames.length === 0) return 0;
    const completed = stageNames.filter((s) => stages[s].status === 'completed').length;
    return Math.round((completed / stageNames.length) * 100);
  }

  private updateRuntimeUrl(url: string): void {
    const el = document.getElementById('opencode-url') as HTMLAnchorElement | null;
    if (el) {
      el.href = url;
      el.textContent = url;
    }
  }

  private updateProjectDir(path: string): void {
    const el = document.getElementById('project-path');
    if (el) {
      el.textContent = path;
    }
    const copyBtn = document.getElementById('copy-project-path-btn') as HTMLButtonElement | null;
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(path).then(() => {
          const original = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = original;
          }, 1500);
        }).catch(() => {
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
          } catch {}
          document.body.removeChild(textArea);
        });
      };
    }
  }

  private updateMainAgentUrl(): void {
    const el = document.getElementById('opencode-session-url') as HTMLAnchorElement | null;
    if (!el || !this.runtimeUrl || !this.dataPlaneSessionId || !this.projectPath) return;
    const base64Path = btoa(this.projectPath);
    const url = `${this.runtimeUrl.replace(/\/$/, '')}/${base64Path}/session/${this.dataPlaneSessionId}`;
    el.href = url;
    el.textContent = url;
  }

  private updateWorkspacePath(path: string): void {
    const el = document.getElementById('workspace-path');
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
          } catch {}
          document.body.removeChild(textArea);
        });
      };
    }
  }

  private updateRepoName(name: string): void {
    const el = document.getElementById('repo-name');
    if (el) {
      el.textContent = name;
    }
  }

  private updateUsage(usage: {
    tokensIn?: number;
    tokensOut?: number;
    tokensReasoning?: number;
    costUsd?: number;
  }): void {
    const fmtInt = (n: number | undefined): string => {
      if (n === undefined || !Number.isFinite(n) || n <= 0) return '-';
      return n.toLocaleString('en-US');
    };
    const fmtCost = (n: number | undefined): string => {
      if (n === undefined || !Number.isFinite(n) || n <= 0) return '-';
      if (n < 0.01) return `$${n.toFixed(4)}`;
      return `$${n.toFixed(2)}`;
    };

    const setText = (id: string, value: string): void => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText('usage-tokens-in', fmtInt(usage.tokensIn));
    setText('usage-tokens-out', fmtInt(usage.tokensOut));
    setText('usage-tokens-reasoning', fmtInt(usage.tokensReasoning));
    setText('usage-cost', fmtCost(usage.costUsd));

    // Hide the "no usage" hint as soon as we have any signal.
    const empty = document.getElementById('usage-empty');
    const hasAny = [usage.tokensIn, usage.tokensOut, usage.tokensReasoning, usage.costUsd]
      .some((v) => v !== undefined && Number.isFinite(v) && v > 0);
    if (empty && hasAny) {
      empty.classList.add('hidden');
    }
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
