/**
 * Pipeline Orchestration Loop
 *
 * Backend-driven stage execution that directly invokes sub-agents for each
 * pipeline stage.  On successful JSON output the pipeline automatically
 * advances to the next stage.
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

export interface PipelineConfig {
  maxRetries: number;
  retryDelayMs: number;
  workspaceDir: string;
  agentsDir: string;
  model?: string;
}

export interface PipelineContext {
  sessionId: string;
  userInput: string;
  currentStage: PipelineStage;
  stageOutputs: Record<string, unknown>;
}

export interface ExecutePipelineOptions {
  sessionId: string;
  opencodeSessionId: string;
  userInput: string;
  workspaceDir: string;
  agentsDir?: string;
  model?: string;
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

const RETRY_DELAYS = [2000, 5000, 10000];

// ============================================================================
// Status Tracking
// ============================================================================

export function initPipelineStatus(sessionId: string): void {
  transaction(() => {
    db.exec(
      `UPDATE sessions SET status = 'running' WHERE id = ?`,
      [sessionId]
    );
  });
}

export function updatePipelineStatus(
  sessionId: string,
  status: 'running' | 'completed' | 'failed'
): void {
  transaction(() => {
    const now = Date.now();
    if (status === 'completed' || status === 'failed') {
      db.exec(
        `UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?`,
        [status, now, sessionId]
      );
    } else {
      db.exec(`UPDATE sessions SET status = ? WHERE id = ?`, [status, sessionId]);
    }
  });
}

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
    `pipeline:\n  current_stage: ${status.pipeline.current_stage}`,
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
        result.pipeline = result.pipeline || {
          current_stage: 'clarify',
          started_at: '',
          updated_at: '',
        };
        result.pipeline.current_stage = trimmed.split(':')[1].trim() as PipelineStage;
      } else if (trimmed.startsWith('started_at:')) {
        result.pipeline = result.pipeline || {
          current_stage: 'clarify',
          started_at: '',
          updated_at: '',
        };
        result.pipeline.started_at = trimmed.split(':')[1].trim();
      } else if (trimmed.startsWith('updated_at:')) {
        result.pipeline = result.pipeline || {
          current_stage: 'clarify',
          started_at: '',
          updated_at: '',
        };
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

export async function executePipeline(options: ExecutePipelineOptions): Promise<PipelineStatus> {
  const finalConfig: PipelineConfig = {
    ...DEFAULT_CONFIG,
    workspaceDir: options.workspaceDir,
    agentsDir: options.agentsDir ?? DEFAULT_CONFIG.agentsDir,
    model: options.model,
  };

  const sessionId = options.sessionId;
  const opencodeSessionId = options.opencodeSessionId;

  let status = createInitialStatus(sessionId);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.workspaceDir);

  const context: PipelineContext = {
    sessionId,
    userInput: options.userInput,
    currentStage: 'clarify',
    stageOutputs: {},
  };

  const { client } = await OpenCodeManager.getOrCreate(finalConfig.workspaceDir);

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

async function runMainAgentLoop(
  client: OpenCodeClient,
  opencodeSessionId: string,
  context: PipelineContext,
  status: PipelineStatus,
  config: PipelineConfig
): Promise<PipelineStatus> {
  let currentStatus = status;
  let attempts = 0;

  while (true) {
    attempts++;
    if (attempts > config.maxRetries) {
      throw new Error(
        `Max retries (${config.maxRetries}) exceeded for stage ${context.currentStage}`
      );
    }

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
        context.currentStage,
        attempts,
        config
      );

      // Any valid JSON object is treated as successful stage output.
      currentStatus = updateStageStatus(
        currentStatus,
        context.currentStage,
        'completed',
        attempts,
        JSON.stringify(response)
      );
      await writeStatusFile(context.sessionId, currentStatus, config.workspaceDir);
      context.stageOutputs[context.currentStage] = response;

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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const recoverable = isRecoverableError(error);

      if (recoverable && attempts < config.maxRetries) {
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
}

// ============================================================================
// Prompt & Communication
// ============================================================================

function buildPrompt(context: PipelineContext): PromptPart[] {
  const parts: PromptPart[] = [];

  parts.push({
    type: 'text',
    text: `## User Requirements\n\n${context.userInput}\n\n## Session Context\n- Session ID: ${context.sessionId}\n- Current Stage: ${context.currentStage}\n- Workspace Base: workspace/run-${context.sessionId}/\n`,
  });

  if (Object.keys(context.stageOutputs).length > 0) {
    parts.push({
      type: 'text',
      text: '\n## Previous Stage Outputs\n\n',
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
    text: `\nPlease complete the **${context.currentStage}** stage and output your response as a JSON object matching the schema defined in your instructions. Output ONLY the JSON — no extra commentary outside the JSON block.\n`,
  });

  return parts;
}

async function sendPromptWithRetry(
  client: OpenCodeClient,
  sessionId: string,
  parts: PromptPart[],
  agentName: string,
  attempt: number,
  config: PipelineConfig
): Promise<Record<string, unknown>> {
  if (attempt === 1) {
    // Capture baseline timestamp so we only look at messages created after
    // our prompt was sent.
    const messagesBefore = await client.getMessages(sessionId);
    const baselineTime =
      messagesBefore.length > 0
        ? Math.max(...messagesBefore.map((m) => m.time.created))
        : 0;

    await client.sendMessage(sessionId, parts, { agent: agentName, model: config.model });
    return await pollForResponse(client, sessionId, baselineTime);
  }
  try {
    // On retry we do not have a clean baseline; poll from the beginning.
    return await pollForResponse(client, sessionId, 0);
  } catch (error) {
    if (attempt < config.maxRetries && isRecoverableError(error)) {
      await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
      return sendPromptWithRetry(client, sessionId, parts, agentName, attempt + 1, config);
    }
    throw error;
  }
}

async function pollForResponse(
  client: OpenCodeClient,
  sessionId: string,
  baselineTime: number,
  maxAttempts = 300,
  pollIntervalMs = 3000
): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxAttempts; i++) {
    const messages = await client.getMessages(sessionId);
    const newAssistantMessages = messages.filter(
      (m) => m.role === 'assistant' && m.time.created > baselineTime
    );

    for (const msg of newAssistantMessages) {
      if (msg.finish === 'stop') {
        const textParts =
          msg.parts?.filter((p) => p.type === 'text' && p.text) || [];
        for (const part of textParts) {
          const extracted = extractJSON(part.text!);
          if (
            extracted &&
            typeof extracted === 'object' &&
            !Array.isArray(extracted)
          ) {
            return extracted as Record<string, unknown>;
          }
        }
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error('Timeout waiting for agent response');
}

function extractJSON(text: string): unknown {
  // 1. fenced code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }
  // 2. first top-level object
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {}
  }
  // 3. whole text
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getNextStage(currentStage: PipelineStage): PipelineStage | null {
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  if (currentIndex === -1 || currentIndex >= STAGE_ORDER.length - 1) {
    return null;
  }
  return STAGE_ORDER[currentIndex + 1];
}

function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    const recoverablePatterns = [
      /timeout/i,
      /rate.?limit/i,
      /network/i,
      /connection/i,
      /ECONNREFUSED/,
      /ECONNRESET/,
      /ETIMEDOUT/,
    ];
    return recoverablePatterns.some((p) => p.test(error.message));
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { STAGE_ORDER, DEFAULT_CONFIG, RETRY_DELAYS };
