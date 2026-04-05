interface SessionItem {
  id: string;
  status: string;
  opencode_url: string | null;
  current_agent: string | null;
  agent_name: string;
  project_name: string;
  requirements: string;
  tech_stack: string;
  created_at: number;
  completed_at: number | null;
}

const API_ENDPOINT = '/api/sessions';

class SessionListPage {
  private container: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private modalInput: HTMLInputElement | null = null;
  private modalTargetName: HTMLElement | null = null;
  private modalConfirmBtn: HTMLButtonElement | null = null;
  private modalCancelBtn: HTMLButtonElement | null = null;
  private modalError: HTMLElement | null = null;
  private pendingDeleteId: string | null = null;
  private pendingDeleteName: string | null = null;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    this.container = document.getElementById('session-list-container');
    this.modal = document.getElementById('delete-modal');
    this.modalInput = document.getElementById('delete-confirm-input') as HTMLInputElement | null;
    this.modalTargetName = document.getElementById('delete-target-name');
    this.modalConfirmBtn = document.getElementById('delete-confirm-btn') as HTMLButtonElement | null;
    this.modalCancelBtn = document.getElementById('delete-cancel-btn') as HTMLButtonElement | null;
    this.modalError = document.getElementById('delete-error');

    await this.loadConfig();
    this.bindModalEvents();
    this.loadSessions();
  }

  private async loadConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) return;
      const data = (await response.json()) as { useDataPlane?: boolean };
      if (data.useDataPlane) {
        const agentsLink = document.getElementById('nav-agents');
        agentsLink?.classList.remove('hidden');
      }
    } catch {
      // ignore
    }
  }

  private bindModalEvents(): void {
    this.modalCancelBtn?.addEventListener('click', () => this.closeModal());
    this.modal?.addEventListener('click', (e) => {
      if (e.target === this.modal) this.closeModal();
    });

    this.modalInput?.addEventListener('input', () => this.checkDeleteConfirm());

    this.modalConfirmBtn?.addEventListener('click', () => this.confirmDelete());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModal();
    });
  }

  private async loadSessions(): Promise<void> {
    if (!this.container) return;

    try {
      const response = await fetch(API_ENDPOINT);
      if (!response.ok) {
        this.container.innerHTML = `<div class="empty-state">Failed to load sessions.</div>`;
        return;
      }

      const sessions = (await response.json()) as SessionItem[];
      this.render(sessions);
    } catch {
      if (this.container) {
        this.container.innerHTML = `<div class="empty-state">Failed to load sessions.</div>`;
      }
    }
  }

  private render(sessions: SessionItem[]): void {
    if (!this.container) return;

    if (sessions.length === 0) {
      this.container.innerHTML = `
        <div class="empty-state">
          <p>No projects yet.</p>
          <a href="create.html" class="btn btn-primary" style="margin-top: 12px;">Create your first project</a>
        </div>
      `;
      return;
    }

    this.container.innerHTML = `
      <table class="session-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Status</th>
            <th class="hide-sm">Agent</th>
            <th class="hide-sm">Created</th>
            <th class="hide-sm">Ended</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map((s) => this.renderSessionRow(s)).join('')}
        </tbody>
      </table>
    `;

    // Bind action buttons
    this.container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.id!;
        const name = (e.currentTarget as HTMLElement).dataset.name!;
        this.openDeleteModal(id, name);
      });
    });
  }

  private renderSessionRow(s: SessionItem): string {
    const date = new Date(s.created_at).toLocaleString();
    const endedDate = s.completed_at ? new Date(s.completed_at).toLocaleString() : '-';
    const statusClass = this.statusBadgeClass(s.status);
    return `
      <tr>
        <td><a href="status.html?session=${encodeURIComponent(s.id)}">${this.escapeHtml(s.project_name)}</a></td>
        <td><span class="badge ${statusClass}">${s.status}</span></td>
        <td class="hide-sm">${this.escapeHtml(s.agent_name || 'local')}</td>
        <td class="hide-sm">${date}</td>
        <td class="hide-sm">${endedDate}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 8px;">
            <a href="status.html?session=${encodeURIComponent(s.id)}" class="btn btn-primary" style="padding: 5px 10px;">View</a>
            <button type="button" class="btn btn-danger" style="padding: 5px 10px;" data-action="delete" data-id="${this.escapeHtml(s.id)}" data-name="${this.escapeHtml(s.project_name)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }

  private statusBadgeClass(status: string): string {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'running':
        return 'running';
      default:
        return 'pending';
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private openDeleteModal(id: string, name: string): void {
    this.pendingDeleteId = id;
    this.pendingDeleteName = name;

    if (this.modalTargetName) {
      this.modalTargetName.textContent = name;
    }
    if (this.modalInput) {
      this.modalInput.value = '';
    }
    if (this.modalError) {
      this.modalError.textContent = '';
      this.modalError.classList.add('hidden');
    }
    if (this.modalConfirmBtn) {
      this.modalConfirmBtn.disabled = true;
    }

    this.modal?.classList.add('open');
    this.modal?.setAttribute('aria-hidden', 'false');
    this.modalInput?.focus();
  }

  private closeModal(): void {
    this.modal?.classList.remove('open');
    this.modal?.setAttribute('aria-hidden', 'true');
    this.pendingDeleteId = null;
    this.pendingDeleteName = null;
  }

  private checkDeleteConfirm(): void {
    if (!this.modalInput || !this.modalConfirmBtn) return;
    const value = this.modalInput.value.trim();
    const matched = value === this.pendingDeleteName;
    this.modalConfirmBtn.disabled = !matched;

    if (this.modalError) {
      this.modalError.textContent = '';
      this.modalError.classList.add('hidden');
    }
  }

  private async confirmDelete(): Promise<void> {
    if (!this.pendingDeleteId || !this.pendingDeleteName) return;

    if (this.modalInput?.value.trim() !== this.pendingDeleteName) {
      if (this.modalError) {
        this.modalError.textContent = 'Project name does not match.';
        this.modalError.classList.remove('hidden');
      }
      return;
    }

    if (this.modalConfirmBtn) {
      this.modalConfirmBtn.disabled = true;
      this.modalConfirmBtn.textContent = 'Deleting...';
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(this.pendingDeleteId)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Delete failed');
      }

      this.closeModal();
      await this.loadSessions();
    } catch {
      if (this.modalError) {
        this.modalError.textContent = 'Failed to delete project. Please try again.';
        this.modalError.classList.remove('hidden');
      }
      if (this.modalConfirmBtn) {
        this.modalConfirmBtn.disabled = false;
        this.modalConfirmBtn.textContent = 'Delete';
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new SessionListPage();
});
export {}; // Make this file a module to avoid global scope collisions
