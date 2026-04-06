/**
 * Form validation and submission logic for AICoder project creation
 */

interface ProjectFormData {
  projectName: string;
  requirements: string;
  model?: string;
  subagentModel?: string;
  mode?: string;
  pipelineMode?: string;
  existingPath?: string;
  agentId?: string;
  reasoningEffort?: string;
}

interface ValidationError {
  field: string;
  message: string;
}

interface ApiResponse {
  id?: string;
  status?: string;
  error?: string;
  errors?: string[];
}

const API_ENDPOINT = '/api/sessions';
const MODELS_ENDPOINT = '/api/models';
const AGENTS_ENDPOINT = '/api/agents';
const DEFAULT_MODEL = 'zhipuai-coding-plan/glm-4.7-flashx';

interface AgentInfo {
  id: string;
  name: string;
  agentUrl: string;
  runtimeConfig?: string;
  runtimeLink?: string;
  model?: string;
  subagentModel?: string;
  createdAt: number;
}

let availableAgents: AgentInfo[] = [];
let agentModelsCache: Map<string, { model?: string; subagentModel?: string }> = new Map();

async function fetchModels(): Promise<{ models: Array<{ id: string; name: string }>; default: string }> {
  try {
    const response = await fetch(MODELS_ENDPOINT);
    if (!response.ok) return { models: [], default: DEFAULT_MODEL };
    return response.json();
  } catch {
    return { models: [], default: DEFAULT_MODEL };
  }
}

function populateModelSelect(data: { models: Array<{ id: string; name: string }>; default: string }, selectId: string): void {
  const select = document.getElementById(selectId) as HTMLSelectElement;
  if (!select) return;

  select.innerHTML = '';

  if (data.models.length === 0) {
    const opt = document.createElement('option');
    opt.value = DEFAULT_MODEL;
    opt.textContent = DEFAULT_MODEL;
    select.appendChild(opt);
    return;
  }

  for (const model of data.models) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = `${model.name} (${model.id})`;
    if (model.id === data.default || model.id === DEFAULT_MODEL) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }

  if (!select.querySelector('option[selected]')) {
    const first = select.querySelector('option');
    if (first) first.selected = true;
  }
}

function validateProjectName(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return 'Project name is required';
  }

  if (trimmed.length <= 4) {
    return 'Project name must be more than 4 characters';
  }

  if (trimmed.length > 100) {
    return 'Project name must be at most 100 characters';
  }

  if (!/^[a-z]/.test(trimmed)) {
    return 'Project name must start with a lowercase letter';
  }

  if (!/[a-z0-9]$/.test(trimmed)) {
    return 'Project name must end with a letter or number';
  }

  if (!/^[a-z0-9_-]+$/.test(trimmed)) {
    return 'Project name can only contain lowercase a-z, 0-9, underscore, and hyphen';
  }

  return null;
}

function validateExistingPath(value: string, mode: string): string | null {
  if (mode !== 'existing') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Existing project path is required';
  }
  if (!trimmed.startsWith('/')) {
    return 'Existing project path must be an absolute path';
  }
  return null;
}

function validateRequirements(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return 'Requirements is required';
  }

  if (trimmed.length < 10) {
    return 'Requirements must be at least 10 characters';
  }

  return null;
}

function validateForm(formData: ProjectFormData): ValidationError[] {
  const errors: ValidationError[] = [];
  const mode = formData.mode || 'new';

  const projectNameError = validateProjectName(formData.projectName);
  if (projectNameError) {
    errors.push({ field: 'projectName', message: projectNameError });
  }

  const existingPathError = validateExistingPath(formData.existingPath || '', mode);
  if (existingPathError) {
    errors.push({ field: 'existingPath', message: existingPathError });
  }

  const requirementsError = validateRequirements(formData.requirements);
  if (requirementsError) {
    errors.push({ field: 'requirements', message: requirementsError });
  }

  if (!formData.agentId) {
    errors.push({ field: 'agentId', message: 'Please select an agent' });
  }

  return errors;
}

function showFieldError(fieldId: string, message: string): void {
  const input = document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement;
  const errorSpan = document.getElementById(`${fieldId}-error`) as HTMLElement;

  if (input) {
    input.classList.add('error');
  }

  if (errorSpan) {
    errorSpan.textContent = message;
    errorSpan.classList.remove('hidden');
  }
}

function clearFieldError(fieldId: string): void {
  const input = document.getElementById(fieldId) as HTMLInputElement | HTMLTextAreaElement;
  const errorSpan = document.getElementById(`${fieldId}-error`) as HTMLElement;

  if (input) {
    input.classList.remove('error');
  }

  if (errorSpan) {
    errorSpan.textContent = '';
    errorSpan.classList.add('hidden');
  }
}

function clearAllErrors(): void {
  const fields = ['projectName', 'existingPath', 'requirements', 'agentId'];
  fields.forEach(field => clearFieldError(field));

  const errorContainer = document.getElementById('error-container') as HTMLElement;
  const errorList = document.getElementById('error-list') as HTMLUListElement;

  if (errorContainer) {
    errorContainer.classList.add('hidden');
  }

  if (errorList) {
    errorList.innerHTML = '';
  }
}

function showValidationErrors(errors: ValidationError[]): void {
  clearAllErrors();

  errors.forEach(error => {
    showFieldError(error.field, error.message);
  });

  const firstErrorField = document.getElementById(errors[0].field) as HTMLElement;
  if (firstErrorField) {
    firstErrorField.focus();
  }
}

function showServerErrors(errors: string[]): void {
  const errorContainer = document.getElementById('error-container') as HTMLElement;
  const errorList = document.getElementById('error-list') as HTMLUListElement;

  if (errorContainer && errorList) {
    errorList.innerHTML = '';

    errors.forEach(error => {
      const li = document.createElement('li');
      li.textContent = error;
      errorList.appendChild(li);
    });

    errorContainer.classList.remove('hidden');
    errorContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setSubmitButtonLoading(loading: boolean): void {
  const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
  const submitText = document.getElementById('submit-text') as HTMLElement;
  const submitSpinner = document.getElementById('submit-spinner') as HTMLElement;

  if (submitBtn && submitText && submitSpinner) {
    submitBtn.disabled = loading;

    if (loading) {
      submitText.textContent = 'Creating...';
      submitSpinner.classList.remove('hidden');
    } else {
      submitText.textContent = 'Create Project';
      submitSpinner.classList.add('hidden');
    }
  }
}

function getFormData(): ProjectFormData {
  const modeRadio = document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null;
  const pipelineModeRadio = document.querySelector('input[name="pipelineMode"]:checked') as HTMLInputElement | null;
  const projectName = (document.getElementById('projectName') as HTMLInputElement)?.value || '';
  const existingPath = (document.getElementById('existingPath') as HTMLInputElement)?.value || '';
  const requirements = (document.getElementById('requirements') as HTMLTextAreaElement)?.value || '';
  const model = (document.getElementById('model') as HTMLSelectElement)?.value || '';
  const subagentModel = (document.getElementById('subagentModel') as HTMLSelectElement)?.value || '';
  const agentId = (document.getElementById('agentId') as HTMLSelectElement)?.value || '';
  const reasoningEffort = (document.getElementById('reasoningEffort') as HTMLSelectElement)?.value || '';

  const formData: ProjectFormData = {
    projectName,
    requirements,
    mode: modeRadio?.value || 'new',
    pipelineMode: pipelineModeRadio?.value || 'standard',
    model: model || undefined,
    subagentModel: subagentModel || undefined,
    reasoningEffort: reasoningEffort || undefined,
  };

  if (formData.mode === 'existing' && existingPath.trim()) {
    formData.existingPath = existingPath.trim();
  }

  if (agentId) formData.agentId = agentId;

  return formData;
}

async function submitForm(formData: ProjectFormData): Promise<void> {
  setSubmitButtonLoading(true);
  clearAllErrors();

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formData),
    });

    const data: ApiResponse = await response.json();

    if (!response.ok) {
      if (response.status === 400 && data.errors) {
        showServerErrors(data.errors);
      } else {
        showServerErrors([data.error || 'An unexpected error occurred. Please try again.']);
      }
      setSubmitButtonLoading(false);
      return;
    }

    if (data.id) {
      window.location.href = `status.html?session=${encodeURIComponent(data.id)}`;
    } else {
      showServerErrors(['Invalid response from server. Missing session ID.']);
      setSubmitButtonLoading(false);
    }
  } catch (error) {
    console.error('Form submission error:', error);
    showServerErrors(['Network error. Please check your connection and try again.']);
    setSubmitButtonLoading(false);
  }
}

function handleFormSubmit(event: Event): void {
  event.preventDefault();

  const formData = getFormData();
  const errors = validateForm(formData);

  if (errors.length > 0) {
    showValidationErrors(errors);
    return;
  }

  submitForm(formData);
}

async function loadAgents(): Promise<void> {
  const select = document.getElementById('agentId') as HTMLSelectElement | null;
  if (!select) return;
  try {
    const response = await fetch(AGENTS_ENDPOINT);
    if (!response.ok) throw new Error('Failed to load agents');
    availableAgents = (await response.json()) as AgentInfo[];
    
    // Cache agent models
    agentModelsCache.clear();
    for (const agent of availableAgents) {
      agentModelsCache.set(agent.id, {
        model: agent.model,
        subagentModel: agent.subagentModel
      });
    }
    
    select.innerHTML = '';
    if (availableAgents.length === 0) {
      select.innerHTML = '<option value="">No agents available</option>';
      return;
    }
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select an agent';
    select.appendChild(placeholder);
    for (const agent of availableAgents) {
      const opt = document.createElement('option');
      opt.value = agent.id;
      opt.textContent = agent.name;
      select.appendChild(opt);
    }
    
    // Add change listener for agent selection
    select.addEventListener('change', () => {
      updateModelSelectsForAgent(select.value);
    });
  } catch {
    select.innerHTML = '<option value="">Failed to load agents</option>';
  }
}

function updateModelSelectsForAgent(agentId: string): void {
  if (!agentId) return;
  
  const agentModels = agentModelsCache.get(agentId);
  if (!agentModels) return;
  
  const mainModelSelect = document.getElementById('model') as HTMLSelectElement | null;
  const subagentModelSelect = document.getElementById('subagentModel') as HTMLSelectElement | null;
  
  if (agentModels.model && mainModelSelect) {
    // Try to select the agent's main model if it exists in the list
    const mainOption = mainModelSelect.querySelector(`option[value="${agentModels.model}"]`) as HTMLOptionElement | null;
    if (mainOption) {
      mainOption.selected = true;
    }
  }
  
  if (agentModels.subagentModel && subagentModelSelect) {
    // Try to select the agent's subagent model if it exists in the list
    const subOption = subagentModelSelect.querySelector(`option[value="${agentModels.subagentModel}"]`) as HTMLOptionElement | null;
    if (subOption) {
      subOption.selected = true;
    }
  }
}

async function initForm(): Promise<void> {
  const agentGroup = document.getElementById('agent-selection-group');
  const advancedBox = document.getElementById('advanced-options-box');
  if (agentGroup) agentGroup.style.display = 'block';
  if (advancedBox) advancedBox.classList.add('hidden');
  await loadAgents();

  fetchModels().then((data) => {
    populateModelSelect(data, 'model');
    populateModelSelect(data, 'subagentModel');
  }).catch(() => {
    populateModelSelect({ models: [], default: DEFAULT_MODEL }, 'model');
    populateModelSelect({ models: [], default: DEFAULT_MODEL }, 'subagentModel');
  });

  const form = document.getElementById('project-form') as HTMLFormElement;
  if (form) {
    form.addEventListener('submit', handleFormSubmit);
  }

  const inputs = ['projectName', 'existingPath', 'requirements', 'agentId'];
  inputs.forEach(inputId => {
    const input = document.getElementById(inputId) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

    if (input) {
      input.addEventListener('blur', () => {
        const value = input.value;
        const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value || 'new';
        let error: string | null = null;

        switch (inputId) {
          case 'projectName':
            error = validateProjectName(value);
            break;
          case 'existingPath':
            error = validateExistingPath(value, mode);
            break;
          case 'requirements':
            error = validateRequirements(value);
            break;
          case 'agentId':
            if (!value) error = 'Please select an agent';
            break;
        }

        if (error) {
          showFieldError(inputId, error);
        } else {
          clearFieldError(inputId);
        }
      });

      input.addEventListener('input', () => {
        clearFieldError(inputId);
      });
      input.addEventListener('change', () => {
        clearFieldError(inputId);
      });
    }
  });

  const demoBtn = document.getElementById('demo-btn') as HTMLButtonElement | null;

  const modeRadios = document.querySelectorAll('input[name="mode"]');
  modeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const selected = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value || 'new';
      const existingGroup = document.getElementById('existingPath-group');
      if (existingGroup) {
        if (selected === 'existing') {
          existingGroup.classList.remove('hidden');
        } else {
          existingGroup.classList.add('hidden');
          clearFieldError('existingPath');
        }
      }
      if (demoBtn) {
        demoBtn.disabled = selected === 'existing';
        if (selected === 'existing') {
          demoBtn.style.opacity = '0.5';
          demoBtn.style.cursor = 'not-allowed';
        } else {
          demoBtn.style.opacity = '1';
          demoBtn.style.cursor = 'pointer';
        }
      }
    });
  });

  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      const ts = Math.floor(Date.now() / 1000);
      const projectNameInput = document.getElementById('projectName') as HTMLInputElement;
      const requirementsInput = document.getElementById('requirements') as HTMLTextAreaElement;
      const pipelineModeSimple = document.getElementById('pipeline-mode-simple') as HTMLInputElement;
      if (projectNameInput) projectNameInput.value = `todo-list-demo-${ts}`;
      if (requirementsInput) requirementsInput.value = '写一个todo list demo，用 html 实现，细节你自己定';
      if (pipelineModeSimple) pipelineModeSimple.checked = true;
      clearFieldError('projectName');
      clearFieldError('requirements');
    });
  }
}

document.addEventListener('DOMContentLoaded', initForm);
export {}; // Make this file a module to avoid global scope collisions
