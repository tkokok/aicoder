interface SessionMetadata {
  id: string;
  status: string;
  projectName?: string;
  createdAt?: number;
  completedAt?: number;
  runtimeUrl?: string;
  projectPath?: string;
  dataPlaneSessionId?: string;
}

interface ReportResponse {
  markdown?: string;
  status?: string;
  error?: string;
}

interface ErrorResponse {
  error: string;
}

declare const marked: {
  parse(text: string, options?: { breaks?: boolean; gfm?: boolean }): string;
};

const API_BASE = '/api';

function getSessionIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('id');
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildMainAgentUrl(metadata: SessionMetadata): string | null {
  if (!metadata.runtimeUrl || !metadata.projectPath || !metadata.dataPlaneSessionId) return null;
  const base64Path = btoa(metadata.projectPath);
  return `${metadata.runtimeUrl.replace(/\/$/, '')}/${base64Path}/session/${metadata.dataPlaneSessionId}`;
}

function renderMetadata(metadata: SessionMetadata): void {
  const container = document.getElementById('metadata-body');
  if (!container) return;

  const statusBadge = metadata.status === 'completed'
    ? '<span class="badge completed">completed</span>'
    : metadata.status === 'error'
    ? '<span class="badge error">error</span>'
    : '<span class="badge pending">' + escapeHtml(metadata.status) + '</span>';

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Session ID', value: escapeHtml(metadata.id) },
    { label: 'Status', value: statusBadge },
    { label: 'Project', value: escapeHtml(metadata.projectName || 'Unknown') },
    { label: 'Created', value: escapeHtml(metadata.createdAt ? formatDate(metadata.createdAt) : 'N/A') },
  ];

  if (metadata.completedAt) {
    rows.push({ label: 'Completed', value: escapeHtml(formatDate(metadata.completedAt)) });
  }

  const mainAgentUrl = buildMainAgentUrl(metadata);
  if (mainAgentUrl) {
    rows.push({
      label: 'Main Agent',
      value: `<a href="${escapeHtml(mainAgentUrl)}" target="_blank">${escapeHtml(mainAgentUrl)}</a>`,
    });
  }

  container.innerHTML = rows.map(row => `
    <tr>
      <th>${escapeHtml(row.label)}</th>
      <td>${row.value}</td>
    </tr>
  `).join('');

  const backLink = document.getElementById('back-link') as HTMLAnchorElement | null;
  if (backLink) {
    backLink.href = `status.html?session=${encodeURIComponent(metadata.id)}`;
  }
}

function renderLoading(): void {
  const container = document.getElementById('content');
  if (!container) return;

  container.innerHTML = `
    <div class="loading">
      <div class="loading__spinner"></div>
      <p class="loading__text">Loading report...</p>
    </div>
  `;
}

function renderError(message: string, onRetry?: () => void): void {
  const container = document.getElementById('content');
  if (!container) return;

  container.innerHTML = `
    <div class="error">
      <div class="error__icon">⚠️</div>
      <h2 class="error__title">Error Loading Report</h2>
      <p class="error__message">${escapeHtml(message)}</p>
      ${onRetry ? '<button class="error__retry" id="retry-btn">Try Again</button>' : ''}
    </div>
  `;

  if (onRetry) {
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', onRetry);
    }
  }
}

function renderPending(status: string): void {
  const container = document.getElementById('content');
  if (!container) return;

  container.innerHTML = `
    <div class="pending">
      <div class="pending__icon">⏳</div>
      <h2 class="pending__title">Session ${escapeHtml(status)}</h2>
      <p class="pending__message">The report will be available once the session completes.</p>
    </div>
  `;
}

function renderMarkdown(markdown: string): void {
  const container = document.getElementById('content');
  if (!container) return;

  const parsed = marked.parse(markdown, { breaks: true, gfm: true }) as string;
  container.innerHTML = `<div class="markdown-body">${parsed}</div>`;
}

async function fetchSession(sessionId: string): Promise<{ metadata: SessionMetadata; report: ReportResponse | null }> {
  const metadataResponse = await fetch(`${API_BASE}/sessions/${sessionId}`);
  
  if (!metadataResponse.ok) {
    if (metadataResponse.status === 404) {
      throw new Error('Session not found');
    }
    throw new Error('Failed to fetch session');
  }

  const sessionData = await metadataResponse.json() as {
    id: string;
    status: string;
    project_name?: string;
    created_at?: number;
    completed_at?: number;
    runtime_url?: string;
    project_path?: string;
    data_plane_session_id?: string;
  };
  
  const metadata: SessionMetadata = {
    id: sessionData.id,
    status: sessionData.status,
    projectName: sessionData.project_name,
    createdAt: sessionData.created_at,
    completedAt: sessionData.completed_at,
    runtimeUrl: sessionData.runtime_url,
    projectPath: sessionData.project_path,
    dataPlaneSessionId: sessionData.data_plane_session_id,
  };

  let report: ReportResponse | null = null;

  if (sessionData.status === 'completed') {
    const reportResponse = await fetch(`${API_BASE}/sessions/${sessionId}/report`);
    
    if (reportResponse.ok) {
      report = await reportResponse.json() as ReportResponse;
    } else {
      const errorData = await reportResponse.json() as ErrorResponse;
      throw new Error(errorData.error || 'Failed to fetch report');
    }
  }

  return { metadata, report };
}

async function init(): Promise<void> {
  const sessionId = getSessionIdFromUrl();

  if (!sessionId) {
    renderError('No session ID provided. Please include an "id" parameter in the URL.');
    return;
  }

  renderLoading();

  try {
    const { metadata, report } = await fetchSession(sessionId);
    renderMetadata(metadata);

    if (metadata.status === 'completed' && report?.markdown) {
      renderMarkdown(report.markdown);
    } else if (metadata.status === 'pending' || metadata.status === 'running') {
      renderPending(metadata.status);
    } else if (metadata.status === 'error') {
      renderError('Session processing failed. Please check the session logs.');
    } else {
      renderPending(metadata.status);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    renderError(message, () => init());
  }
}

document.addEventListener('DOMContentLoaded', init);