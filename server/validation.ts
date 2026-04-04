/**
 * Validation utilities for session input
 */

/**
 * Validates project name
 * @param name - Project name to validate
 * @returns true if valid, error message if invalid
 */
export function validateProjectName(name: unknown): true | string {
  if (name === undefined || name === null) {
    return "Project name is required";
  }
  if (typeof name !== "string") {
    return "Project name must be a string";
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "Project name cannot be empty or whitespace-only";
  }
  if (trimmed.length <= 4) {
    return "Project name must be more than 4 characters";
  }
  if (trimmed.length > 100) {
    return "Project name must be at most 100 characters";
  }
  if (!/^[a-z]/.test(trimmed)) {
    return "Project name must start with a lowercase letter";
  }
  if (!/[a-z0-9]$/.test(trimmed)) {
    return "Project name must end with a letter or number";
  }
  if (!/^[a-z0-9_-]+$/.test(trimmed)) {
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
    return "Requirements is required";
  }
  if (typeof requirements !== "string") {
    return "Requirements must be a string";
  }
  const trimmed = requirements.trim();
  if (trimmed.length === 0) {
    return "Requirements cannot be empty or whitespace-only";
  }
  if (trimmed.length < 10) {
    return "Requirements must be at least 10 characters";
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
    return "Tech stack is required";
  }
  if (typeof techStack !== "string") {
    return "Tech stack must be a string";
  }
  const trimmed = techStack.trim();
  if (trimmed.length === 0) {
    return "Tech stack cannot be empty or whitespace-only";
  }
  if (trimmed.length > 200) {
    return "Tech stack must be at most 200 characters";
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
  if (trimmed.length > 200) {
    return "Dev environment must be at most 200 characters";
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
  if (trimmed.length > 200) {
    return "Test method must be at most 200 characters";
  }
  return true;
}

/**
 * Session input structure
 */
export interface SessionInput {
  projectName: unknown;
  requirements: unknown;
  techStack: unknown;
  devEnv?: unknown;
  testMethod?: unknown;
  model?: unknown;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates all session input fields
 * @param input - Session input to validate
 * @returns Validation result with valid flag and array of errors
 */
export function validateSessionInput(input: SessionInput): ValidationResult {
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

  const devEnvResult = validateDevEnv(input.devEnv);
  if (devEnvResult !== true) {
    errors.push(devEnvResult);
  }

  const testMethodResult = validateTestMethod(input.testMethod);
  if (testMethodResult !== true) {
    errors.push(testMethodResult);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
