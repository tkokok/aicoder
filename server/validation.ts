/**
 * Validation utilities for session input
 */

import { createComponentLogger } from './logger';

const log = createComponentLogger('validation');

// ============================================================================
// Validation Constants
// ============================================================================

const PROJECT_NAME_MIN_LENGTH = 4;
const PROJECT_NAME_MAX_LENGTH = 100;
const REQUIREMENTS_MIN_LENGTH = 10;
const TECH_STACK_MAX_LENGTH = 200;
const DEV_ENV_MAX_LENGTH = 200;
const TEST_METHOD_MAX_LENGTH = 200;
const OPENCODE_HEADER_MAX_LENGTH = 500;
const OPENCODE_USERNAME_MAX_LENGTH = 200;
const OPENCODE_PASSWORD_MAX_LENGTH = 500;

const VALID_REASONSING_EFFORTS = ['low', 'medium', 'high'] as const;

// ============================================================================
// Validators
// ============================================================================

/**
 * Validates project name
 * @param name - Project name to validate
 * @returns true if valid, error message if invalid
 */
export function validateProjectName(name: unknown): true | string {
  if (name === undefined || name === null) {
    log.warn('Project name validation failed: required', { field: 'project_name', reason: 'required' });
    return "Project name is required";
  }
  if (typeof name !== "string") {
    log.warn('Project name validation failed: not a string', { field: 'project_name', reason: 'type' });
    return "Project name must be a string";
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    log.warn('Project name validation failed: empty', { field: 'project_name', reason: 'empty' });
    return "Project name cannot be empty or whitespace-only";
  }
  if (trimmed.length <= PROJECT_NAME_MIN_LENGTH) {
    log.warn('Project name validation failed: too short', { field: 'project_name', reason: 'min_length', length: trimmed.length, min: PROJECT_NAME_MIN_LENGTH });
    return `Project name must be more than ${PROJECT_NAME_MIN_LENGTH} characters`;
  }
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) {
    log.warn('Project name validation failed: too long', { field: 'project_name', reason: 'max_length', length: trimmed.length, max: PROJECT_NAME_MAX_LENGTH });
    return `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`;
  }
  if (!/^[a-z]/.test(trimmed)) {
    log.warn('Project name validation failed: must start with lowercase letter', { field: 'project_name', reason: 'format', value: trimmed.slice(0, 20) });
    return "Project name must start with a lowercase letter";
  }
  if (!/[a-z0-9]$/.test(trimmed)) {
    log.warn('Project name validation failed: must end with letter or number', { field: 'project_name', reason: 'format', value: trimmed.slice(0, 20) });
    return "Project name must end with a letter or number";
  }
  if (!/^[a-z0-9_-]+$/.test(trimmed)) {
    log.warn('Project name validation failed: invalid characters', { field: 'project_name', reason: 'invalid_chars', value: trimmed.slice(0, 20) });
    return "Project name can only contain lowercase a-z, 0-9, underscore, and hyphen";
  }
  return true;
}

/**
 * Validates requirements
 * @param requirements - Requirements text to validate
 * @returns true if valid, error message if invalid
 */
export function validateRequirements(requirements: unknown): true | string {
  if (requirements === undefined || requirements === null) {
    log.warn('Requirements validation failed: required', { field: 'requirements', reason: 'required' });
    return "Requirements is required";
  }
  if (typeof requirements !== "string") {
    log.warn('Requirements validation failed: not a string', { field: 'requirements', reason: 'type' });
    return "Requirements must be a string";
  }
  const trimmed = requirements.trim();
  if (trimmed.length === 0) {
    log.warn('Requirements validation failed: empty', { field: 'requirements', reason: 'empty' });
    return "Requirements cannot be empty or whitespace-only";
  }
  if (trimmed.length < REQUIREMENTS_MIN_LENGTH) {
    log.warn('Requirements validation failed: too short', { field: 'requirements', reason: 'min_length', length: trimmed.length, min: REQUIREMENTS_MIN_LENGTH });
    return `Requirements must be at least ${REQUIREMENTS_MIN_LENGTH} characters`;
  }
  return true;
}

/**
 * Validates tech stack
 * @param techStack - Tech stack to validate
 * @returns true if valid, error message if invalid
 */
export function validateTechStack(techStack: unknown): true | string {
  if (techStack === undefined || techStack === null) {
    return true; // Optional field
  }
  if (typeof techStack !== "string") {
    log.warn('Tech stack validation failed: not a string', { field: 'tech_stack', reason: 'type' });
    return "Tech stack must be a string";
  }
  const trimmed = techStack.trim();
  if (trimmed.length === 0) {
    return true; // Optional field
  }
  if (trimmed.length > TECH_STACK_MAX_LENGTH) {
    log.warn('Tech stack validation failed: too long', { field: 'tech_stack', reason: 'max_length', length: trimmed.length, max: TECH_STACK_MAX_LENGTH });
    return `Tech stack must be at most ${TECH_STACK_MAX_LENGTH} characters`;
  }
  return true;
}

/**
 * Validates dev environment (optional)
 * @param devEnv - Dev environment to validate
 * @returns true if valid, error message if invalid
 */
export function validateDevEnv(devEnv: unknown): true | string {
  if (devEnv === undefined || devEnv === null) {
    return true; // Optional field
  }
  if (typeof devEnv !== "string") {
    return "Dev environment must be a string";
  }
  const trimmed = devEnv.trim();
  if (trimmed.length > DEV_ENV_MAX_LENGTH) {
    return `Dev environment must be at most ${DEV_ENV_MAX_LENGTH} characters`;
  }
  return true;
}

/**
 * Validates test method (optional)
 * @param testMethod - Test method to validate
 * @returns true if valid, error message if invalid
 */
export function validateTestMethod(testMethod: unknown): true | string {
  if (testMethod === undefined || testMethod === null) {
    return true; // Optional field
  }
  if (typeof testMethod !== "string") {
    return "Test method must be a string";
  }
  const trimmed = testMethod.trim();
  if (trimmed.length > TEST_METHOD_MAX_LENGTH) {
    return `Test method must be at most ${TEST_METHOD_MAX_LENGTH} characters`;
  }
  return true;
}

/**
 * Session input structure
 */
export interface SessionInput {
  projectName: unknown;
  requirements: unknown;
  techStack?: unknown;
  devEnv?: unknown;
  testMethod?: unknown;
  model?: unknown;
  subagentModel?: unknown;
  mode?: unknown;
  pipelineMode?: unknown;
  existingPath?: unknown;
  opencodeEnv?: unknown;
  opencodeUrl?: unknown;
  opencodeHeader?: unknown;
  opencodeUsername?: unknown;
  opencodePassword?: unknown;
  reasoningEffort?: unknown;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateMode(mode: unknown, existingPath: unknown): true | string {
  if (mode === undefined || mode === null) {
    return true; // default to new
  }
  if (typeof mode !== 'string') {
    return 'Mode must be a string';
  }
  const trimmed = mode.trim();
  if (trimmed !== 'new' && trimmed !== 'existing') {
    return 'Mode must be "new" or "existing"';
  }
  if (trimmed === 'existing') {
    if (existingPath === undefined || existingPath === null) {
      return 'Existing project path is required when mode is "existing"';
    }
    if (typeof existingPath !== 'string') {
      return 'Existing project path must be a string';
    }
    const pathTrimmed = existingPath.trim();
    if (pathTrimmed.length === 0) {
      return 'Existing project path cannot be empty';
    }
    if (!pathTrimmed.startsWith('/')) {
      return 'Existing project path must be an absolute path';
    }
  }
  return true;
}

/**
 * Validates all session input fields
 * @param input - Session input to validate
 * @returns Validation result with valid flag and array of errors
 */
export function validateSessionInput(input: SessionInput): ValidationResult {
  log.info('Starting session input validation', { operation: 'validate_start' });
  const errors: string[] = [];

  const projectNameResult = validateProjectName(input.projectName);
  if (projectNameResult !== true) {
    errors.push(projectNameResult);
  }

  const requirementsResult = validateRequirements(input.requirements);
  if (requirementsResult !== true) {
    errors.push(requirementsResult);
  }

  const techStackResult = validateTechStack(input.techStack);
  if (techStackResult !== true) {
    errors.push(techStackResult);
  }

  const modeResult = validateMode(input.mode, input.existingPath);
  if (modeResult !== true) {
    errors.push(modeResult);
  }

  if (input.opencodeUrl !== undefined && input.opencodeUrl !== null && typeof input.opencodeUrl === 'string' && input.opencodeUrl.trim()) {
    try {
      new URL(input.opencodeUrl);
    } catch {
      log.warn('OpenCode URL validation failed: invalid URL', { field: 'opencode_url', reason: 'invalid_url' });
      errors.push('OpenCode URL must be a valid URL');
    }
  }

  if (input.opencodeHeader !== undefined && input.opencodeHeader !== null && typeof input.opencodeHeader === 'string' && input.opencodeHeader.trim().length > OPENCODE_HEADER_MAX_LENGTH) {
    log.warn('OpenCode header validation failed: too long', { field: 'opencode_header', reason: 'max_length', length: input.opencodeHeader.length, max: OPENCODE_HEADER_MAX_LENGTH });
    errors.push(`OpenCode header must be at most ${OPENCODE_HEADER_MAX_LENGTH} characters`);
  }

  if (input.opencodeUsername !== undefined && input.opencodeUsername !== null && typeof input.opencodeUsername === 'string' && input.opencodeUsername.trim().length > OPENCODE_USERNAME_MAX_LENGTH) {
    log.warn('OpenCode username validation failed: too long', { field: 'opencode_username', reason: 'max_length' });
    errors.push(`OpenCode username must be at most ${OPENCODE_USERNAME_MAX_LENGTH} characters`);
  }

  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null) {
    if (typeof input.reasoningEffort !== 'string' || !(VALID_REASONSING_EFFORTS as readonly string[]).includes(input.reasoningEffort)) {
      log.warn('Reasoning effort validation failed: invalid value', { field: 'reasoning_effort', reason: 'invalid_value', value: input.reasoningEffort });
      errors.push(`Reasoning effort must be one of: ${VALID_REASONSING_EFFORTS.join(', ')}`);
    }
  }

  if (input.opencodePassword !== undefined && input.opencodePassword !== null && typeof input.opencodePassword === 'string' && input.opencodePassword.length > OPENCODE_PASSWORD_MAX_LENGTH) {
    log.warn('OpenCode password validation failed: too long', { field: 'opencode_password', reason: 'max_length' });
    errors.push(`OpenCode password must be at most ${OPENCODE_PASSWORD_MAX_LENGTH} characters`);
  }

  if (errors.length === 0) {
    log.info('Session input validation passed', { operation: 'validate_success' });
  } else {
    log.warn('Session input validation failed', { operation: 'validate_fail', error_count: errors.length, errors });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
