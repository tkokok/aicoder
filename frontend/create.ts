/**
 * Form validation and submission logic for AICoder project creation
 */

interface ProjectFormData {
  projectName: string;
  requirements: string;
  techStack: string;
  model?: string;
  devEnv?: string;
  testMethod?: string;
  mode?: string;
  existingPath?: string;
  opencodeUrl?: string;
  opencodeHeader?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
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
const DEFAULT_MODEL = 'kimi-for-coding/k2p5';

async function fetchModels(): Promise<{ models: Array<{ id: string; name: string }>; default: string }> {
  try {
    const response = await fetch(MODELS_ENDPOINT);
    if (!response.ok) return { models: [], default: DEFAULT_MODEL };
    return response.json();
  } catch {
    return { models: [], default: DEFAULT_MODEL };
  }
}

function populateModelSelect(data: { models: Array<{ id: string; name: string }>; default: string }): void {
  const select = document.getElementById('model') as HTMLSelectElement;
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

function validateTechStack(value: string): string | null {
  const trimmed = value.trim();
  
  if (trimmed.length === 0) {
    return 'Tech stack is required';
  }
  
  if (trimmed.length > 200) {
    return 'Tech stack must be at most 200 characters';
  }
  
  return null;
}

function validateDevEnv(value: string): string | null {
  const trimmed = value.trim();
  
  if (trimmed.length > 200) {
    return 'Dev environment must be at most 200 characters';
  }
  
  return null;
}

function validateTestMethod(value: string): string | null {
  const trimmed = value.trim();
  
  if (trimmed.length > 200) {
    return 'Test method must be at most 200 characters';
  }
  
  return null;
}

function validateOpencodeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    new URL(trimmed);
  } catch {
    return 'OpenCode URL must be a valid URL';
  }
  return null;
}

function validateOpencodeHeader(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) {
    return 'OpenCode header must be at most 500 characters';
  }
  return null;
}

function validateOpencodeUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) {
    return 'OpenCode username must be at most 200 characters';
  }
  return null;
}

function validateOpencodePassword(value: string): string | null {
  if (!value) return null;
  if (value.length > 500) {
    return 'OpenCode password must be at most 500 characters';
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

  const techStackError = validateTechStack(formData.techStack);
  if (techStackError) {
    errors.push({ field: 'techStack', message: techStackError });
  }

  if (formData.devEnv) {
    const devEnvError = validateDevEnv(formData.devEnv);
    if (devEnvError) {
      errors.push({ field: 'devEnv', message: devEnvError });
    }
  }

  if (formData.testMethod) {
    const testMethodError = validateTestMethod(formData.testMethod);
    if (testMethodError) {
      errors.push({ field: 'testMethod', message: testMethodError });
    }
  }

  if (formData.opencodeUrl) {
    const urlError = validateOpencodeUrl(formData.opencodeUrl);
    if (urlError) errors.push({ field: 'opencodeUrl', message: urlError });
  }
  if (formData.opencodeHeader) {
    const headerError = validateOpencodeHeader(formData.opencodeHeader);
    if (headerError) errors.push({ field: 'opencodeHeader', message: headerError });
  }
  if (formData.opencodeUsername) {
    const usernameError = validateOpencodeUsername(formData.opencodeUsername);
    if (usernameError) errors.push({ field: 'opencodeUsername', message: usernameError });
  }
  if (formData.opencodePassword) {
    const passwordError = validateOpencodePassword(formData.opencodePassword);
    if (passwordError) errors.push({ field: 'opencodePassword', message: passwordError });
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
  const fields = ['projectName', 'existingPath', 'requirements', 'techStack', 'devEnv', 'testMethod', 'opencodeUrl', 'opencodeHeader', 'opencodeUsername', 'opencodePassword'];
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
  const projectName = (document.getElementById('projectName') as HTMLInputElement)?.value || '';
  const existingPath = (document.getElementById('existingPath') as HTMLInputElement)?.value || '';
  const requirements = (document.getElementById('requirements') as HTMLTextAreaElement)?.value || '';
  const techStack = (document.getElementById('techStack') as HTMLInputElement)?.value || '';
  const model = (document.getElementById('model') as HTMLSelectElement)?.value || '';
  const devEnv = (document.getElementById('devEnv') as HTMLInputElement)?.value || '';
  const testMethod = (document.getElementById('testMethod') as HTMLInputElement)?.value || '';
  const opencodeUrl = (document.getElementById('opencodeUrl') as HTMLInputElement)?.value || '';
  const opencodeHeader = (document.getElementById('opencodeHeader') as HTMLInputElement)?.value || '';
  const opencodeUsername = (document.getElementById('opencodeUsername') as HTMLInputElement)?.value || '';
  const opencodePassword = (document.getElementById('opencodePassword') as HTMLInputElement)?.value || '';

  const formData: ProjectFormData = {
    projectName,
    requirements,
    techStack,
    mode: modeRadio?.value || 'new',
    model: model || undefined,
  };

  if (formData.mode === 'existing' && existingPath.trim()) {
    formData.existingPath = existingPath.trim();
  }

  if (devEnv.trim()) {
    formData.devEnv = devEnv;
  }

  if (testMethod.trim()) {
    formData.testMethod = testMethod;
  }

  if (opencodeUrl.trim()) {
    formData.opencodeUrl = opencodeUrl.trim();
  }
  if (opencodeHeader.trim()) {
    formData.opencodeHeader = opencodeHeader.trim();
  }
  if (opencodeUsername.trim()) {
    formData.opencodeUsername = opencodeUsername.trim();
  }
  if (opencodePassword) {
    formData.opencodePassword = opencodePassword;
  }

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

function initForm(): void {
  fetchModels().then(populateModelSelect).catch(() => {
    populateModelSelect({ models: [], default: DEFAULT_MODEL });
  });

  const form = document.getElementById('project-form') as HTMLFormElement;
  
  if (form) {
    form.addEventListener('submit', handleFormSubmit);
  }
  
  const inputs = ['projectName', 'existingPath', 'requirements', 'techStack', 'devEnv', 'testMethod', 'opencodeUrl', 'opencodeHeader', 'opencodeUsername', 'opencodePassword'];
  inputs.forEach(inputId => {
    const input = document.getElementById(inputId) as HTMLInputElement | HTMLTextAreaElement;

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
          case 'techStack':
            error = validateTechStack(value);
            break;
          case 'devEnv':
            error = validateDevEnv(value);
            break;
          case 'testMethod':
            error = validateTestMethod(value);
            break;
          case 'opencodeUrl':
            error = validateOpencodeUrl(value);
            break;
          case 'opencodeHeader':
            error = validateOpencodeHeader(value);
            break;
          case 'opencodeUsername':
            error = validateOpencodeUsername(value);
            break;
          case 'opencodePassword':
            error = validateOpencodePassword(value);
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
    }
  });

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
    });
  });
}

document.addEventListener('DOMContentLoaded', initForm);
export {}; // Make this file a module to avoid global scope collisions