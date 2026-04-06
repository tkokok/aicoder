interface Agent {
  id: string;
  name: string;
  agentUrl: string;
  runtimeConfig?: string;
  runtimeLink?: string;
  model?: string;
  subagentModel?: string;
  createdAt: number;
}

interface ModelInfo {
  id: string;
  name: string;
  providerID: string;
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

  // Model selection related
  private availableModels: ModelInfo[] = [];
  private connectionTested = false;

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
    document.getElementById('fill-opencode-btn')?.addEventListener('click', () => this.fillOpenCodeRuntime());
    document.getElementById('test-connection-btn')?.addEventListener('click', () => this.testConnection());
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
            <th class="hide-sm">Models</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${this.agents.map((a) => `
            <tr>
              <td><strong>${this.escapeHtml(a.name)}</strong></td>
              <td>${this.escapeHtml(a.agentUrl)}</td>
              <td class="hide-sm">${this.escapeHtml(a.runtimeConfig || '-')}</td>
              <td class="hide-sm">
                ${a.model ? `<div>Main: ${this.escapeHtml(a.model)}</div>` : ''}
                ${a.subagentModel ? `<div>Sub: ${this.escapeHtml(a.subagentModel)}</div>` : '-'}
              </td>
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
    this.connectionTested = false;
    this.availableModels = [];
    if (this.modalTitle) this.modalTitle.textContent = 'Add Agent';
    this.setFormValue('agent-name', '');
    this.setFormValue('agent-url', 'http://127.0.0.1:2080');
    this.setFormValue('runtime-config', '');
    this.setFormValue('runtime-link', '');
    this.setFormValue('main-model', '');
    this.setFormValue('subagent-model', '');
    this.hideModelSelects();
    this.updateConnectionStatus('');
    this.hideModalError();
    this.openModal();
  }

  private fillOpenCodeRuntime(): void {
    this.setFormValue('runtime-config', '{"type":"opencode","url":"http://127.0.0.1:4096"}');
    this.setFormValue('runtime-link', 'http://127.0.0.1:4096');
  }

  private async testConnection(): Promise<void> {
    const runtimeConfig = this.getFormValue('runtime-config');
    const statusEl = document.getElementById('connection-status');
    const testBtn = document.getElementById('test-connection-btn') as HTMLButtonElement | null;

    if (!runtimeConfig) {
      this.updateConnectionStatus('Please enter Runtime Config first', 'error');
      return;
    }

    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
    }

    try {
      const response = await fetch('/api/agents/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtimeConfig }),
      });

      const data = await response.json() as { success: boolean; models?: ModelInfo[]; error?: string };

      if (response.ok && data.success && data.models) {
        this.availableModels = data.models;
        this.connectionTested = true;
        this.updateConnectionStatus(`✅ Connection successful! Found ${data.models.length} models`, 'success');
        this.showModelSelects(data.models);
      } else {
        this.connectionTested = false;
        this.availableModels = [];
        this.updateConnectionStatus(`❌ Connection failed: ${data.error || 'Unknown error'}`, 'error');
        this.hideModelSelects();
      }
    } catch (err) {
      this.connectionTested = false;
      this.availableModels = [];
      this.updateConnectionStatus(`❌ Connection failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.hideModelSelects();
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = '🔗 Test Connection';
      }
    }
  }

  private updateConnectionStatus(message: string, type?: 'success' | 'error'): void {
    const statusEl = document.getElementById('connection-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.remove('connection-success', 'connection-error');
    if (type) {
      statusEl.classList.add(type === 'success' ? 'connection-success' : 'connection-error');
    }
  }

  private showModelSelects(models: ModelInfo[]): void {
    const mainGroup = document.getElementById('model-select-group');
    const subGroup = document.getElementById('subagent-model-select-group');
    const mainSelect = document.getElementById('main-model') as HTMLSelectElement | null;
    const subSelect = document.getElementById('subagent-model') as HTMLSelectElement | null;

    if (!mainSelect || !subSelect) return;

    // Populate selects
    const options = models.map(m => `<option value="${this.escapeHtml(m.id)}">${this.escapeHtml(m.name)} (${this.escapeHtml(m.providerID)})</option>`).join('');
    const defaultOption = '<option value="">Select a model...</option>';
    
    mainSelect.innerHTML = defaultOption + options;
    subSelect.innerHTML = defaultOption + options;

    // Show groups
    mainGroup?.classList.remove('hidden');
    subGroup?.classList.remove('hidden');
  }

  private hideModelSelects(): void {
    const mainGroup = document.getElementById('model-select-group');
    const subGroup = document.getElementById('subagent-model-select-group');
    mainGroup?.classList.add('hidden');
    subGroup?.classList.add('hidden');
  }

  private openEditModal(id: string): void {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent) return;
    this.editingId = id;
    this.connectionTested = false;
    this.availableModels = [];
    if (this.modalTitle) this.modalTitle.textContent = 'Edit Agent';
    this.setFormValue('agent-name', agent.name);
    this.setFormValue('agent-url', agent.agentUrl);
    this.setFormValue('runtime-config', agent.runtimeConfig || '');
    this.setFormValue('runtime-link', agent.runtimeLink || '');
    this.setFormValue('main-model', agent.model || '');
    this.setFormValue('subagent-model', agent.subagentModel || '');
    
    // For edit mode, we need to test connection again to show model selects
    // But we pre-fill the values if they exist
    this.hideModelSelects();
    this.updateConnectionStatus(agent.model ? `Current models: Main=${agent.model}, Sub=${agent.subagentModel || agent.model}` : 'Click "Test Connection" to select models');
    
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
    this.connectionTested = false;
    this.availableModels = [];
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
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    return el?.value.trim() || '';
  }

  private setFormValue(id: string, value: string): void {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
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
    const runtimeConfig = this.getFormValue('runtime-config');
    const mainModel = this.getFormValue('main-model');
    const subagentModel = this.getFormValue('subagent-model');

    if (!name) return 'Name is required';
    if (!agentUrl) return 'Agent URL is required';
    if (!/^https?:\/\//i.test(agentUrl)) return 'Agent URL must start with http:// or https://';
    if (runtimeLink && !/^https?:\/\//i.test(runtimeLink)) return 'Runtime link must start with http:// or https://';
    
    // Require runtime config if models are selected
    if ((mainModel || subagentModel) && !runtimeConfig) {
      return 'Runtime Config is required when selecting models';
    }
    
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
      model: this.getFormValue('main-model'),
      subagentModel: this.getFormValue('subagent-model'),
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
