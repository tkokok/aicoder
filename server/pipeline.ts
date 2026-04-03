/**
 * Pipeline Orchestration Loop
 * 
 * Main Agent orchestration logic for managing the development pipeline.
 * Handles task execution, retry logic, and status tracking.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { OpenCodeClient, OpenCodeManager } from './opencode';
import { db, generateId, transaction } from './db';
import type { PromptPart } from './opencode';

// ============================================================================
// Types
// ============================================================================

export type PipelineStage = 
  | 'clarify'
  | 'design'
  | 'task'
  | 'dev'
  | 'test'
  | 'review'
  | 'validate';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StageResult {
  status: StageStatus;
  attempts: number;
  output?: string;
  error?: string;
}

export interface PipelineStatus {
  session_id: string;
  pipeline: {
    current_stage: PipelineStage | 'completed' | 'failed';
    started_at: string;
    updated_at: string;
  };
  stages: Record<PipelineStage, StageResult>;
  errors: Array<{
    stage: PipelineStage;
    message: string;
    timestamp: string;
    recoverable: boolean;
  }>;
}

export interface AgentResponse {
  finish: 'stop' | 'continue';
  output: Record<string, unknown>;
  error?: string;
}

export interface PipelineConfig {
  maxRetries: number;
  retryDelayMs: number;
  workspaceDir: string;
  agentsDir: string;
}

export interface PipelineContext {
  sessionId: string;
  userInput: string;
  currentStage: PipelineStage;
  stageOutputs: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const STAGE_ORDER: PipelineStage[] = [
  'clarify',
  'design',
  'task',
  'dev',
  'test',
  'review',
  'validate',
];

const DEFAULT_CONFIG: PipelineConfig = {
  maxRetries: 3,
  retryDelayMs: 2000,
  workspaceDir: './workspace',
  agentsDir: './agents',
};

const RETRY_DELAYS = [2000, 5000, 10000]; // Exponential backoff: 2s, 5s, 10s

// ============================================================================
// Status Tracking
// ============================================================================

/**
 * Initialize pipeline status in database
 */
export function initPipelineStatus(sessionId: string): void {
  transaction(() => {
    const now = Date.now();
    
    db.exec(`
      INSERT INTO sessions (id, status, created_at)
      VALUES (?, 'running', ?)
    `, [sessionId, now]);
  });
}

/**
 * Update pipeline status in database
 */
export function updatePipelineStatus(
  sessionId: string,
  status: 'running' | 'completed' | 'failed'
): void {
  transaction(() => {
    const now = Date.now();
    
    if (status === 'completed' || status === 'failed') {
      db.exec(`
        UPDATE sessions
        SET status = ?, completed_at = ?
        WHERE id = ?
      `, [status, now, sessionId]);
    } else {
      db.exec(`
        UPDATE sessions
        SET status = ?
        WHERE id = ?
      `, [status, sessionId]);
    }
  });
}

/**
 * Write status to YAML file
 */
export async function writeStatusFile(
  sessionId: string,
  status: PipelineStatus,
  workspaceDir: string
): Promise<string> {
  const runDir = join(workspaceDir, `run-${sessionId}`);
  const statusPath = join(runDir, 'status.yaml');
  
  await mkdir(runDir, { recursive: true });
  
  const yaml = statusToYaml(status);
  
  await writeFile(statusPath, yaml, 'utf-8');
  
  return statusPath;
}

/**
 * Read status from YAML file
 */
export async function readStatusFile(
  sessionId: string,
  workspaceDir: string
): Promise<PipelineStatus | null> {
  const statusPath = join(workspaceDir, `run-${sessionId}`, 'status.yaml');
  
  try {
    const content = await readFile(statusPath, 'utf-8');
    return yamlToStatus(content);
  } catch {
    return null;
  }
}

/**
 * Create initial pipeline status
 */
export function createInitialStatus(sessionId: string): PipelineStatus {
  const now = new Date().toISOString();
  
  const stages: Record<PipelineStage, StageResult> = {
    clarify: { status: 'pending', attempts: 0 },
    design: { status: 'pending', attempts: 0 },
    task: { status: 'pending', attempts: 0 },
    dev: { status: 'pending', attempts: 0 },
    test: { status: 'pending', attempts: 0 },
    review: { status: 'pending', attempts: 0 },
    validate: { status: 'pending', attempts: 0 },
  };
  
  return {
    session_id: sessionId,
    pipeline: {
      current_stage: 'clarify',
      started_at: now,
      updated_at: now,
    },
    stages,
    errors: [],
  };
}

/**
 * Update stage status
 */
export function updateStageStatus(
  status: PipelineStatus,
  stage: PipelineStage,
  stageStatus: StageStatus,
  attempts: number,
  output?: string,
  error?: string
): PipelineStatus {
  const now = new Date().toISOString();
  
  return {
    ...status,
    pipeline: {
      ...status.pipeline,
      updated_at: now,
    },
    stages: {
      ...status.stages,
      [stage]: {
        status: stageStatus,
        attempts,
        output,
        error,
      },
    },
  };
}

/**
 * Add error to status
 */
export function addError(
  status: PipelineStatus,
  stage: PipelineStage,
  message: string,
  recoverable: boolean
): PipelineStatus {
  const now = new Date().toISOString();
  
  return {
    ...status,
    errors: [
      ...status.errors,
      {
        stage,
        message,
        timestamp: now,
        recoverable,
      },
    ],
  };
}

// ============================================================================
// YAML Helpers
// ============================================================================

function statusToYaml(status: PipelineStatus): string {
  const lines: string[] = [
    `session_id: ${status.session_id}`,
    `pipeline:`,
    `  current_stage: ${status.pipeline.current_stage}`,
    `  started_at: ${status.pipeline.started_at}`,
    `  updated_at: ${status.pipeline.updated_at}`,
    `stages:`,
  ];
  
  for (const stage of STAGE_ORDER) {
    const stageResult = status.stages[stage];
    lines.push(`  ${stage}:`);
    lines.push(`    status: ${stageResult.status}`);
    lines.push(`    attempts: ${stageResult.attempts}`);
    if (stageResult.output) {
      lines.push(`    output: ${stageResult.output}`);
    }
    if (stageResult.error) {
      lines.push(`    error: ${stageResult.error}`);
    }
  }
  
  if (status.errors.length > 0) {
    lines.push(`errors:`);
    for (const error of status.errors) {
      lines.push(`  - stage: ${error.stage}`);
      lines.push(`    message: ${error.message}`);
      lines.push(`    timestamp: ${error.timestamp}`);
      lines.push(`    recoverable: ${error.recoverable}`);
    }
  }
  
  return lines.join('\n');
}

function yamlToStatus(yaml: string): PipelineStatus {
  // Simple YAML parser for our specific format
  const lines = yaml.split('\n');
  const result: Partial<PipelineStatus> = {
    stages: {} as Record<PipelineStage, StageResult>,
    errors: [],
  };
  
  let currentSection = '';
  let currentStage: PipelineStage | null = null;
  let currentError: Partial<PipelineStatus['errors'][0]> | null = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith('session_id:')) {
      result.session_id = trimmed.split(':')[1].trim();
    } else if (trimmed === 'pipeline:') {
      currentSection = 'pipeline';
    } else if (trimmed === 'stages:') {
      currentSection = 'stages';
    } else if (trimmed === 'errors:') {
      currentSection = 'errors';
    } else if (currentSection === 'pipeline') {
      if (trimmed.startsWith('current_stage:')) {
        result.pipeline = result.pipeline || { current_stage: 'clarify', started_at: '', updated_at: '' };
        result.pipeline.current_stage = trimmed.split(':')[1].trim() as PipelineStage;
      } else if (trimmed.startsWith('started_at:')) {
        result.pipeline = result.pipeline || { current_stage: 'clarify', started_at: '', updated_at: '' };
        result.pipeline.started_at = trimmed.split(':')[1].trim();
      } else if (trimmed.startsWith('updated_at:')) {
        result.pipeline = result.pipeline || { current_stage: 'clarify', started_at: '', updated_at: '' };
        result.pipeline.updated_at = trimmed.split(':')[1].trim();
      }
    } else if (currentSection === 'stages') {
      if (trimmed.endsWith(':') && STAGE_ORDER.includes(trimmed.slice(0, -1) as PipelineStage)) {
        currentStage = trimmed.slice(0, -1) as PipelineStage;
        result.stages![currentStage] = { status: 'pending', attempts: 0 };
      } else if (currentStage) {
        if (trimmed.startsWith('status:')) {
          result.stages![currentStage].status = trimmed.split(':')[1].trim() as StageStatus;
        } else if (trimmed.startsWith('attempts:')) {
          result.stages![currentStage].attempts = parseInt(trimmed.split(':')[1].trim());
        } else if (trimmed.startsWith('output:')) {
          result.stages![currentStage].output = trimmed.split(':')[1].trim();
        } else if (trimmed.startsWith('error:')) {
          result.stages![currentStage].error = trimmed.split(':')[1].trim();
        }
      }
    } else if (currentSection === 'errors') {
      if (trimmed.startsWith('- stage:')) {
        currentError = { stage: trimmed.split(':')[1].trim() as PipelineStage };
      } else if (currentError) {
        if (trimmed.startsWith('message:')) {
          currentError.message = trimmed.split(':')[1].trim();
        } else if (trimmed.startsWith('timestamp:')) {
          currentError.timestamp = trimmed.split(':')[1].trim();
        } else if (trimmed.startsWith('recoverable:')) {
          currentError.recoverable = trimmed.split(':')[1].trim() === 'true';
          result.errors!.push(currentError as PipelineStatus['errors'][0]);
          currentError = null;
        }
      }
    }
  }
  
  return result as PipelineStatus;
}

// ============================================================================
// Main Orchestration Loop
// ============================================================================

/**
 * Execute pipeline with retry logic
 */
export async function executePipeline(
  userInput: string,
  config: Partial<PipelineConfig> = {}
): Promise<PipelineStatus> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const sessionId = generateId();
  
  let status = createInitialStatus(sessionId);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.workspaceDir);
  
  const { client } = await OpenCodeManager.getOrCreate(finalConfig.workspaceDir);
  
  const session = await client.createSession({ title: `Pipeline ${sessionId}` });
  const opencodeSessionId = session.id;
  
  const context: PipelineContext = {
    sessionId,
    userInput,
    currentStage: 'clarify',
    stageOutputs: {},
  };
  
  try {
    const result = await runMainAgentLoop(client, opencodeSessionId, context, status, finalConfig);
    updatePipelineStatus(sessionId, 'completed');
    return result;
  } catch (error) {
    updatePipelineStatus(sessionId, 'failed');
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    status = addError(status, context.currentStage, errorMessage, false);
    await writeStatusFile(sessionId, status, finalConfig.workspaceDir);
    
    throw error;
  }
}

/**
 * Main agent loop with retry logic
 */
async function runMainAgentLoop(
  client: OpenCodeClient,
  opencodeSessionId: string,
  context: PipelineContext,
  status: PipelineStatus,
  config: PipelineConfig
): Promise<PipelineStatus> {
  let currentStatus = status;
  let attempts = 0;
  
  while (attempts < config.maxRetries) {
    attempts++;
    
    currentStatus = updateStageStatus(
      currentStatus,
      context.currentStage,
      'running',
      attempts
    );
    await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
    
    try {
      const promptParts = buildPrompt(context);
      
      const response = await sendPromptWithRetry(
        client,
        opencodeSessionId,
        promptParts,
        attempts,
        config
      );
      
      if (response.finish === 'stop') {
        currentStatus = updateStageStatus(
          currentStatus,
          context.currentStage,
          'completed',
          attempts,
          JSON.stringify(response.output)
        );
        await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
        
        context.stageOutputs[context.currentStage] = response.output;
        
        const nextStage = getNextStage(context.currentStage);
        
        if (!nextStage) {
          currentStatus = {
            ...currentStatus,
            pipeline: {
              ...currentStatus.pipeline,
              current_stage: 'completed',
            },
          };
          await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
          return currentStatus;
        }
        
        context.currentStage = nextStage;
        currentStatus = {
          ...currentStatus,
          pipeline: {
            ...currentStatus.pipeline,
            current_stage: nextStage,
          },
        };
        await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
        
        attempts = 0;
        continue;
      }
      
      continue;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      const isRecoverable = isRecoverableError(error);
      
      if (isRecoverable && attempts < config.maxRetries) {
        currentStatus = addError(currentStatus, context.currentStage, errorMessage, true);
        await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
        
        await delay(RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        continue;
      }
      
      currentStatus = updateStageStatus(
        currentStatus,
        context.currentStage,
        'failed',
        attempts,
        undefined,
        errorMessage
      );
      currentStatus = addError(currentStatus, context.currentStage, errorMessage, false);
      await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
      
      throw error;
    }
  }
  
  throw new Error(`Max retries (${config.maxRetries}) exceeded for stage ${context.currentStage}`);
}

/**
 * Send prompt with retry logic
 */
async function sendPromptWithRetry(
  client: OpenCodeClient,
  sessionId: string,
  parts: PromptPart[],
  attempt: number,
  config: PipelineConfig
): Promise<AgentResponse> {
  try {
    await client.sendMessage(sessionId, parts);
    
    const response = await pollForResponse(client, sessionId);
    
    return response;
  } catch (error) {
    if (attempt < config.maxRetries && isRecoverableError(error)) {
      await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
      return sendPromptWithRetry(client, sessionId, parts, attempt + 1, config);
    }
    
    throw error;
  }
}

/**
 * Poll for response from agent
 */
async function pollForResponse(
  client: OpenCodeClient,
  sessionId: string,
  maxAttempts: number = 60,
  pollIntervalMs: number = 1000
): Promise<AgentResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const messages = await client.getMessages(sessionId);
    
    const lastAssistantMessage = [...messages]
      .reverse()
      .find(m => m.role === 'assistant');
    
    if (lastAssistantMessage) {
      const textPart = lastAssistantMessage.parts?.find(p => p.type === 'text' && p.text);
      if (textPart?.text) {
        try {
          const parsed = JSON.parse(textPart.text);
          
          if (parsed.finish && (parsed.finish === 'stop' || parsed.finish === 'continue')) {
            return parsed as AgentResponse;
          }
        } catch {
          // Not valid JSON, continue polling
        }
      }
    }
    
    await delay(pollIntervalMs);
  }
  
  throw new Error('Timeout waiting for agent response');
}

/**
 * Build prompt parts for Main Agent
 */
function buildPrompt(context: PipelineContext): PromptPart[] {
  const parts: PromptPart[] = [];

  parts.push({
    type: 'text',
    text: `You are the AICoder Main Agent orchestrating a 7-stage development pipeline.

## Current Context

Session ID: ${context.sessionId}
Current Stage: ${context.currentStage}
User Input: ${context.userInput}

## Pipeline Stages
1. clarify - Clarify requirements
2. design - Design architecture
3. task - Break down tasks
4. dev - Implement code
5. test - Write tests
6. review - Review code
7. validate - Final validation`,
  });

  if (Object.keys(context.stageOutputs).length > 0) {
    parts.push({
      type: 'text',
      text: '\n\n## Previous Stage Outputs\n\n',
    });

    for (const [stage, output] of Object.entries(context.stageOutputs)) {
      parts.push({
        type: 'text',
        text: `### ${stage}\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n\n`,
      });
    }
  }

  parts.push({
    type: 'text',
    text: `\n\n## Output Format\n\nRespond with a JSON object containing:\n- \`finish\`: "stop" if stage is complete, "continue" if you need to continue\n- \`output\`: The structured output for this stage\n- \`error\`: (optional) Error message if something went wrong\n\nUse the appropriate schema for the current stage (${context.currentStage}).\n`,
  });

  return parts;
}

/**
 * Get next stage in pipeline
 */
function getNextStage(currentStage: PipelineStage): PipelineStage | null {
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  
  if (currentIndex === -1 || currentIndex >= STAGE_ORDER.length - 1) {
    return null;
  }
  
  return STAGE_ORDER[currentIndex + 1];
}

/**
 * Check if error is recoverable
 */
function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Network errors, timeouts, rate limits are recoverable
    const recoverablePatterns = [
      /timeout/i,
      /rate.?limit/i,
      /network/i,
      /connection/i,
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ETIMEDOUT/,
    ];
    
    return recoverablePatterns.some(pattern => pattern.test(error.message));
  }
  
  return false;
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Exports
// ============================================================================

export {
  STAGE_ORDER,
  DEFAULT_CONFIG,
  RETRY_DELAYS,
};