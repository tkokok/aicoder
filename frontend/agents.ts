interface Agent {
  id: string;
  name: string;
  agentUrl: string;
  runtimeConfig?: string;
  runtimeLink?: string;
  createdAt: number;
}

const API_ENDPOINT = '/api/agents';

class AgentsPage {
  private container: HTMLElement | null = null;
  private agents: Agent[] = [];

  private modal: HTMLElement | null = null;
  private modalTitle: HTMLElement | null = null;
  private modalError: HTMLElement | null = null;
  private modalSaveBtn: HTMLButtonElement | null = null;
  private modalCancelBtn: HTMLButtonElement | null = null;

  private deleteModal: HTMLElement | null = null;
  private deleteConfirmBtn: HTMLButtonElement | null = null;
  private deleteCancelBtn: HTMLButtonElement | null = null;
  private deleteError: HTMLElement | null = null;

  private editingId: string | null = null;
  private pendingDeleteId: string | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    this.container = document.getElementById('agent-list-container');
    this.modal = document.getElementById('agent-modal');
    this.modalTitle = document.getElementById('modal-title');
    this.modalError = document.getElementById('modal-error');
    this.modalSaveBtn = document.getElementById('modal-save-btn') as HTMLButtonElement | null;
    this.modalCancelBtn = document.getElementById('modal-cancel-btn') as HTMLButtonElement | null;

    this.deleteModal = document.getElementById('delete-modal');
    this.deleteConfirmBtn = document.getElementById('delete-confirm-btn') as HTMLButtonElement | null;
    this.deleteCancelBtn = document.getElementById('delete-cancel-btn') as HTMLButtonElement | null;
    this.deleteError = document.getElementById('delete-error');

    document.getElementById('add-agent-btn')?.addEventListener('click', () => this.openAddModal());
    this.modalSaveBtn?.addEventListener('click', () => this.saveAgent());
    this.modalCancelBtn?.addEventListener('click', () => this.closeModal());
    this.deleteConfirmBtn?.addEventListener('click', () => this.confirmDelete());
    this.deleteCancelBtn?.addEventListener('click', () => this.closeDeleteModal());

    this.modal?.addEventListener('click', (e) => {
      if (e.target === this.modal) this.closeModal();
    });
    this.deleteModal?.addEventListener('click', (e) => {
      if (e.target === this.deleteModal) this.closeDeleteModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        this.closeDeleteModal();
      }
    });

    this.loadAgents();
  }

  private async loadAgents(): Promise<void> {
    if (!this.container) return;
    try {
      const response = await fetch(API_ENDPOINT);
      if (!response.ok) throw new Error('Failed to load agents');
      this.agents = (await response.json()) as Agent[];
      this.render();
    } catch {
      this.container.innerHTML = `<div class="empty-state">Failed to load agents.</div>`;
    }
  }

  private render(): void {
    if (!this.container) return;
    if (this.agents.length === 0) {
      this.container.innerHTML = `<div class="empty-state">No agents yet. Click "+ Add Agent" to create one.</div>`;
      return;
    }

    this.container.innerHTML = `
      <table class="agent-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Agent URL</th>
            <th class="hide-sm">Runtime Config</th>
            <th class="hide-sm">Runtime Link</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${this.agents.map((a) => `
            <tr>
              <td><strong>${this.escapeHtml(a.name)}</strong></td>
              <td>${this.escapeHtml(a.agentUrl)}</td>
              <td class="hide-sm">${this.escapeHtml(a.runtimeConfig || '-')}</td>
              <td class="hide-sm">${this.escapeHtml(a.runtimeLink || '-')}</td>
              <td style="text-align: right;">
                <div style="display: inline-flex; gap: 8px;">
                  <button type="button" class="btn btn-primary" style="padding: 5px 10px;" data-action="edit" data-id="${this.escapeHtml(a.id)}">Edit</button>
                  <button type="button" class="btn btn-danger" style="padding: 5px 10px;" data-action="delete" data-id="${this.escapeHtml(a.id)}">Delete</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    this.container.querySelectorAll('[data-action="edit"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.id!;
        this.openEditModal(id);
      });
    });
    this.container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = (e.currentTarget as HTMLElement).dataset.id!;
        this.openDeleteModal(id);
      });
    });
  }

  private openAddModal(): void {
    this.editingId = null;
    if (this.modalTitle) this.modalTitle.textContent = 'Add Agent';
    this.setFormValue('agent-name', '');
    this.setFormValue('agent-url', 'http://127.0.0.1:2080');
    this.setFormValue('runtime-config', '');
    this.setFormValue('runtime-link', '');
    this.hideModalError();
    this.openModal();
  }

  private openEditModal(id: string): void {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return;
    this.editingId = id;
    if (this.modalTitle) this.modalTitle.textContent = 'Edit Agent';
    this.setFormValue('agent-name', agent.name);
    this.setFormValue('agent-url', agent.agentUrl);
    this.setFormValue('runtime-config', agent.runtimeConfig || '');
    this.setFormValue('runtime-link', agent.runtimeLink || '');
    this.hideModalError();
    this.openModal();
  }

  private openDeleteModal(id: string): void {
    this.pendingDeleteId = id;
    this.hideDeleteError();
    this.deleteModal?.classList.add('open');
    this.deleteModal?.setAttribute('aria-hidden', 'false');
  }

  private closeModal(): void {
    this.modal?.classList.remove('open');
    this.modal?.setAttribute('aria-hidden', 'true');
    this.editingId = null;
  }

  private closeDeleteModal(): void {
    this.deleteModal?.classList.remove('open');
    this.deleteModal?.setAttribute('aria-hidden', 'true');
    this.pendingDeleteId = null;
  }

  private openModal(): void {
    this.modal?.classList.add('open');
    this.modal?.setAttribute('aria-hidden', 'false');
  }

  private getFormValue(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el?.value.trim() || '';
  }

  private setFormValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value;
  }

  private showModalError(message: string): void {
    if (this.modalError) {
      this.modalError.textContent = message;
      this.modalError.classList.remove('hidden');
    }
  }

  private hideModalError(): void {
    if (this.modalError) {
      this.modalError.textContent = '';
      this.modalError.classList.add('hidden');
    }
  }

  private showDeleteError(message: string): void {
    if (this.deleteError) {
      this.deleteError.textContent = message;
      this.deleteError.classList.remove('hidden');
    }
  }

  private hideDeleteError(): void {
    if (this.deleteError) {
      this.deleteError.textContent = '';
      this.deleteError.classList.add('hidden');
    }
  }

  private validateForm(): string | null {
    const name = this.getFormValue('agent-name');
    const agentUrl = this.getFormValue('agent-url');
    const runtimeLink = this.getFormValue('runtime-link');

    if (!name) return 'Name is required';
    if (!agentUrl) return 'Agent URL is required';
    if (!/^https?:\/\//i.test(agentUrl)) return 'Agent URL must start with http:// or https://';
    if (runtimeLink && !/^https?:\/\//i.test(runtimeLink)) return 'Runtime link must start with http:// or https://';
    return null;
  }

  private async saveAgent(): Promise<void> {
    const error = this.validateForm();
    if (error) {
      this.showModalError(error);
      return;
    }

    const payload = {
      name: this.getFormValue('agent-name'),
      agentUrl: this.getFormValue('agent-url'),
      runtimeConfig: this.getFormValue('runtime-config'),
      runtimeLink: this.getFormValue('runtime-link'),
    };

    if (this.modalSaveBtn) {
      this.modalSaveBtn.disabled = true;
      this.modalSaveBtn.textContent = 'Saving...';
    }

    try {
      const url = this.editingId ? `${API_ENDPOINT}/${encodeURIComponent(this.editingId)}` : API_ENDPOINT;
      const method = this.editingId ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string; errors?: string[] };
        throw new Error(data.errors?.[0] || data.error || 'Save failed');
      }

      this.closeModal();
      await this.loadAgents();
    } catch (err) {
      this.showModalError(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.modalSaveBtn) {
        this.modalSaveBtn.disabled = false;
        this.modalSaveBtn.textContent = 'Save';
      }
    }
  }

  private async confirmDelete(): Promise<void> {
    if (!this.pendingDeleteId) return;
    if (this.deleteConfirmBtn) {
      this.deleteConfirmBtn.disabled = true;
      this.deleteConfirmBtn.textContent = 'Deleting...';
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/${encodeURIComponent(this.pendingDeleteId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || 'Delete failed');
      }
      this.closeDeleteModal();
      await this.loadAgents();
    } catch (err) {
      this.showDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.deleteConfirmBtn) {
        this.deleteConfirmBtn.disabled = false;
        this.deleteConfirmBtn.textContent = 'Delete';
      }
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new AgentsPage();
});

export {};
