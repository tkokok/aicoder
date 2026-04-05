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
  private opencodeUrl: string | null = null;
  private lastError: string | null = null;

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

    const toggleBtn = document.getElementById('toggle-history-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const container = document.getElementById('messages-history');
        const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        const newExpanded = !isExpanded;
        toggleBtn.setAttribute('aria-expanded', String(newExpanded));
        if (container) {
          container.style.display = newExpanded ? 'block' : 'none';
        }
        const count = container?.children.length || 0;
        toggleBtn.textContent = newExpanded ? `Hide History (${count})` : `Show Full History (${count})`;
      });
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

      if (typeof data.opencode_url === 'string' && data.opencode_url) {
        this.opencodeUrl = data.opencode_url;
        this.updateOpenCodeUrl(data.opencode_url);
      }

      if (typeof data.project_path === 'string' && data.project_path) {
        this.updateProjectDir(data.project_path);
      }

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

      const status = typeof data.status === 'string' ? data.status : 'pending';
      const currentStage = typeof data.current_agent === 'string' ? data.current_agent : undefined;
      const latestMessage = typeof data.latest_message === 'string' ? data.latest_message : undefined;
      let messagesList: string[] | undefined;
      if (data.messages_json && typeof data.messages_json === 'string') {
        try {
          messagesList = JSON.parse(data.messages_json) as string[];
        } catch {}
      }

      if (latestMessage !== undefined) {
        this.updateLatestMessage(latestMessage || 'Waiting for updates...');
      }
      if (messagesList !== undefined) {
        this.updateMessagesHistory(messagesList);
      }

      if (status === 'completed') {
        this.updatePipelineState('Completed', 'completed');
        this.updateProgress(100);
      } else if (status === 'failed') {
        const errorMsg = this.lastError || 'Pipeline failed';
        this.updatePipelineState('Failed', 'failed', errorMsg);
        this.updateProgress(0);
      } else if (currentStage) {
        const stepName = currentStage === 'completed'
          ? 'Completed'
          : currentStage === 'failed'
          ? 'Failed'
          : currentStage.replace(' agent', '');
        this.updatePipelineState(stepName, 'running');
      } else {
        this.updatePipelineState('Initializing', 'pending');
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
    const progressPercent = typeof data.progress_percent === 'number' ? data.progress_percent : undefined;

    if (latestMessage !== undefined) {
      this.updateLatestMessage(latestMessage || 'Waiting for updates...');
    }
    if (messagesList !== undefined) {
      this.updateMessagesHistory(messagesList);
    }

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
        window.location.href = `report.html?session=${this.sessionId}`;
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
      } else {
        errorBox.classList.add('hidden');
      }
    }
  }

  private updateLatestMessage(text: string): void {
    const el = document.getElementById('latest-message');
    if (el) {
      el.textContent = text;
    }
  }

  private updateMessagesHistory(messages: string[]): void {
    const container = document.getElementById('messages-history');
    const toggleBtn = document.getElementById('toggle-history-btn');
    if (!container) return;

    container.innerHTML = '';
    for (const msg of messages) {
      const item = document.createElement('div');
      item.style.cssText = 'padding: var(--space-3); border-bottom: 1px solid var(--color-neutral-100); white-space: pre-wrap; font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--color-neutral-700);';
      item.textContent = msg;
      container.appendChild(item);
    }

    if (toggleBtn) {
      const count = messages.length;
      const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.textContent = isExpanded ? `Hide History (${count})` : `Show Full History (${count})`;
    }
  }

  private updateOpenCodeUrl(url: string): void {
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
