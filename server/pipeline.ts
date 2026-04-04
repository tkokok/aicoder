/**
 * Pipeline Orchestration Loop
 *
 * Main Agent-driven orchestration.  The backend sends a single prompt to the
 * Main Agent and waits for it to complete the entire 7-stage pipeline by
 * calling sub-agents autonomously.
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
  projectDir: string;
  agentsDir: string;
  model?: string;
}

export interface ExecutePipelineOptions {
  sessionId: string;
  opencodeSessionId: string;
  userInput: string;
  workspaceDir: string;
  projectDir: string;
  client: OpenCodeClient;
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
  projectDir: './workspace',
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
    projectDir: options.projectDir,
    agentsDir: options.agentsDir ?? DEFAULT_CONFIG.agentsDir,
    model: options.model,
  };

  const sessionId = options.sessionId;
  const opencodeSessionId = options.opencodeSessionId;

  let status = createInitialStatus(sessionId);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  try {
    const result = await runMainAgentLoop(options.client, opencodeSessionId, options.userInput, sessionId, status, finalConfig);
    updatePipelineStatus(sessionId, 'completed');
    return result;
  } catch (error) {
    updatePipelineStatus(sessionId, 'failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    status = addError(status, 'validate', errorMessage, false);
    await writeStatusFile(sessionId, status, finalConfig.projectDir);
    throw error;
  }
}

async function runMainAgentLoop(
  client: OpenCodeClient,
  opencodeSessionId: string,
  userInput: string,
  sessionId: string,
  status: PipelineStatus,
  config: PipelineConfig
): Promise<PipelineStatus> {
  const promptParts = buildMainAgentPrompt(userInput, sessionId, config.workspaceDir, config.projectDir);

  const response = await sendPromptWithRetry(
    client,
    opencodeSessionId,
    promptParts,
    config
  );

  // Try to build a status object from the main agent's final JSON report.
  const finalStatus = await buildStatusFromMainAgentResponse(sessionId, status, response, config.projectDir);
  await writeStatusFile(sessionId, finalStatus, config.projectDir);
  return finalStatus;
}

function buildMainAgentPrompt(
  userInput: string,
  sessionId: string,
  workspaceDir: string,
  projectDir: string
): PromptPart[] {
  const callSubAgentsSection = [
    '## How to Call Sub-Agents (CRITICAL)',
    'You MUST invoke sub-agents using the `task` tool. This is the ONLY way to call a sub-agent in this system.',
    '',
    'For EACH stage, call the `task` tool with exactly these parameters:',
    '- `description`: a short 3-5 word summary of the stage',
    '- `prompt`: the full instructions you want the sub-agent to execute',
    '- `subagent_type`: the exact agent name for this stage (one of: clarify, design, task, dev, test, review, validate)',
    '',
    'Example for the clarify stage:',
    '```',
    'task({',
    '  description: "Clarify requirements",',
    '  prompt: "Please clarify these requirements for a TodoList application...",',
    '  subagent_type: "clarify"',
    '})',
    '```',
    '',
    '- DO NOT simply write @clarify in plain text — that does NOTHING.',
    '- You MUST use the `task` tool for EVERY stage.',
    '- After the `task` tool returns, validate its output, save it as JSON, then call the next stage\'s `task` tool.',
    '- WAIT for each `task` tool to complete before calling the next one.',
  ].join('\n');

  return [
    {
      type: 'text',
      text: [
        'You are AICoder, the strict pipeline controller.',
        '',
        '## Context for This Session',
        `- Session ID: ${sessionId}`,
        `- Workspace Directory (where code lives): ${workspaceDir}/`,
        `- Stage JSON outputs go here: ${projectDir}/run-${sessionId}/<stage>.json`,
        `- Implementation code must be created in: ${workspaceDir}/`,
        '',
        '## User Requirements',
        userInput,
        '',
        callSubAgentsSection,
        '',
        '## Reminder',
        '- Call exactly ONE sub-agent per stage, wait for its response, validate it, save the JSON, then move to the next stage.',
        `- The @dev agent MUST write source files to the workspace directory (${workspaceDir}).`,
        `- Pipeline JSON outputs MUST be saved to ${projectDir}/run-${sessionId}/<stage>.json.`,
        '- You may retry a failed stage at most 2 additional times (3 attempts total).',
        '- If a stage still fails after 3 attempts, stop the pipeline and mark it as failed.',
        '- NEVER do the sub-agent\'s work yourself.',
        '- Return ONLY the final JSON object when done.',
      ].join('\n'),
    },
  ];
}

async function readStageOutputsFromDisk(
  sessionId: string,
  workspaceDir: string
): Promise<Partial<Record<PipelineStage, { status: string; output?: unknown }>>> {
  const result: Partial<Record<PipelineStage, { status: string; output?: unknown }>> = {};
  const runDir = join(workspaceDir, `run-${sessionId}`);
  for (const stage of STAGE_ORDER) {
    try {
      const content = await readFile(join(runDir, `${stage}.json`), 'utf-8');
      const parsed = JSON.parse(content);
      result[stage] = {
        status: 'completed',
        output: parsed,
      };
    } catch {
      // File missing or unreadable — ignore.
    }
  }
  return result;
}

async function buildStatusFromMainAgentResponse(
  sessionId: string,
  status: PipelineStatus,
  response: Record<string, unknown>,
  workspaceDir: string
): Promise<PipelineStatus> {
  const now = new Date().toISOString();
  const pipelineStatus = response.pipeline_status === 'failed' ? 'failed' : 'completed';

  // Merge on-disk stage outputs with whatever the Main Agent returned.
  const diskStages = await readStageOutputsFromDisk(sessionId, workspaceDir);
  const responseStages = (response.stages as Record<string, { status: string; output?: unknown }> | undefined) || {};
  const mergedStages: Record<string, { status: string; output?: unknown }> = { ...diskStages, ...responseStages };

  const updatedStages: Record<PipelineStage, StageResult> = { ...status.stages };

  for (const stage of STAGE_ORDER) {
    const stageData = mergedStages[stage];
    if (stageData) {
      updatedStages[stage] = {
        status: (stageData.status as StageStatus) || 'completed',
        attempts: 1,
        output: stageData.output ? JSON.stringify(stageData.output) : undefined,
      };
    } else {
      updatedStages[stage] = {
        status: pipelineStatus === 'completed' ? 'completed' : 'pending',
        attempts: 0,
      };
    }
  }

  const errors = (response.errors as Array<{ stage: string; message: string; fatal?: boolean }> | undefined) || [];
  const mappedErrors = errors.map((e) => ({
    stage: (e.stage as PipelineStage) || 'validate',
    message: e.message,
    timestamp: now,
    recoverable: !e.fatal,
  }));

  return {
    session_id: sessionId,
    pipeline: {
      current_stage: pipelineStatus === 'completed' ? 'completed' : 'failed',
      started_at: status.pipeline.started_at,
      updated_at: now,
    },
    stages: updatedStages,
    errors: [...status.errors, ...mappedErrors],
  };
}

// ============================================================================
// Prompt & Communication
// ============================================================================

async function sendPromptWithRetry(
  client: OpenCodeClient,
  sessionId: string,
  parts: PromptPart[],
  config: PipelineConfig
): Promise<Record<string, unknown>> {
  let attempt = 0;
  while (attempt < config.maxRetries) {
    attempt++;
    try {
      await client.sendMessage(sessionId, parts, { agent: 'AICoder', model: config.model || 'zhipuai-coding-plan/glm-5.1' });
      return await pollForResponse(client, sessionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (attempt < config.maxRetries && isRecoverableError(error)) {
        await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
        continue;
      }
      throw new Error(`Main Agent failed: ${errorMessage}`);
    }
  }
  throw new Error('Max retries exceeded for Main Agent');
}

async function pollForResponse(
  client: OpenCodeClient,
  sessionId: string,
  maxAttempts = 600,
  pollIntervalMs = 5000
): Promise<Record<string, unknown>> {
  let consecutiveErrors = 0;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const messages = await client.getMessages(sessionId);
      consecutiveErrors = 0;
      const assistantMessages = messages.filter((m) => m.role === 'assistant');

      // Look for the most recent assistant message with finish=stop.
      for (let j = assistantMessages.length - 1; j >= 0; j--) {
        const msg = assistantMessages[j];
        if (msg.finish === 'stop') {
          const textParts = msg.parts?.filter((p) => p.type === 'text' && p.text) || [];
          let rawText = '';
          for (const part of textParts) {
            rawText += part.text! + '\n';
            const extracted = extractJSON(part.text!);
            if (
              extracted &&
              typeof extracted === 'object' &&
              !Array.isArray(extracted)
            ) {
              return extracted as Record<string, unknown>;
            }
          }
          // If finish=stop was found but JSON could not be parsed, don't loop
          // forever waiting for another message. Return a fallback so the
          // backend can recover using on-disk stage outputs.
          return {
            finish: 'stop',
            pipeline_status: 'completed',
            _rawResponse: rawText.trim(),
          };
        }
      }
    } catch (error) {
      if (isRecoverableError(error) && consecutiveErrors < 5) {
        consecutiveErrors++;
        await delay(RETRY_DELAYS[Math.min(consecutiveErrors - 1, RETRY_DELAYS.length - 1)]);
        continue;
      }
      throw error;
    }
    await delay(pollIntervalMs);
  }
  throw new Error('Timeout waiting for Main Agent response');
}

function extractJSON(text: string): unknown {
  // Try all code blocks, starting from the last one (most likely final JSON).
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (let i = codeBlockMatches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(codeBlockMatches[i][1].trim());
    } catch {}
  }

  // Try to find the last balanced brace block.
  const braceMatches = [...text.matchAll(/\{[\s\S]*\}/g)];
  for (let i = braceMatches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(braceMatches[i][0]);
    } catch {}
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
      /503/,
      /502/,
      /504/,
      /429/,
      /Service Unavailable/,
      /Bad Gateway/,
      /Gateway Timeout/,
      /Too Many Requests/,
    ];
    return recoverablePatterns.some((p) => p.test(error.message));
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { STAGE_ORDER, DEFAULT_CONFIG, RETRY_DELAYS };
