/**
 * Pipeline Orchestration Loop
 *
 * Backend-driven stage machine. The backend explicitly drives each stage of the
 * pipeline, sending focused per-stage prompts to the main agent. This prevents
 * the "one giant prompt" failure mode and allows precise retry control.
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

const STAGE_VALIDATION: Record<PipelineStage, string> = {
  clarify: `
- MUST return either: status = "confirmed" OR a list of questions (≤ 3)
- MUST produce a complete clarified requirement summary
`,
  design: `
- MUST include: tech stack, architecture, API definition (if applicable), file structure
- MUST be actionable for implementation
`,
  task: `
- MUST contain concrete implementation tasks
- EACH task MUST include: description and done criteria
`,
  dev: `
- MUST include files_created or files_modified (non-empty)
- MUST match the task scope
- Files MUST actually exist in the workspace directory
`,
  test: `
- MUST include test_files or execution_result
- MUST report pass/fail status
`,
  review: `
- MUST include approved (true/false) and an issues list
`,
  validate: `
- MUST include status ("passed" or "failed")
- MUST include verification details
`,
};

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
      current_stage: stage,
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
// Stage Output I/O
// ============================================================================

async function readStageOutput(
  sessionId: string,
  stage: PipelineStage,
  projectDir: string
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(join(projectDir, `run-${sessionId}`, `${stage}.json`), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readAllStageOutputs(
  sessionId: string,
  projectDir: string
): Promise<Partial<Record<PipelineStage, Record<string, unknown>>>> {
  const result: Partial<Record<PipelineStage, Record<string, unknown>>> = {};
  for (const stage of STAGE_ORDER) {
    const output = await readStageOutput(sessionId, stage, projectDir);
    if (output) {
      result[stage] = output;
    }
  }
  return result;
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
  const userInput = options.userInput;

  let status = createInitialStatus(sessionId);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  try {
    for (const stage of STAGE_ORDER) {
      status = updateStageStatus(status, stage, 'running', 0);
      await writeStatusFile(sessionId, status, finalConfig.projectDir);

      let stageResult: { status: StageStatus; subagentSessionId?: string; error?: string } = {
        status: 'pending',
      };
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          const previousOutputs = await readAllStageOutputs(sessionId, finalConfig.projectDir);
          const previousSubagentSessionId = previousOutputs[stage]?.subagent_session_id as string | undefined;

          const promptParts = buildStagePrompt(
            stage,
            userInput,
            sessionId,
            finalConfig,
            previousOutputs,
            previousSubagentSessionId
          );

          const response = await sendPromptWithRetry(
            options.client,
            opencodeSessionId,
            promptParts,
            finalConfig
          );

          // Prefer reading the saved JSON from disk over parsing the response.
          const savedOutput = await readStageOutput(sessionId, stage, finalConfig.projectDir);
          if (savedOutput) {
            stageResult = {
              status: (savedOutput.status as StageStatus) || 'completed',
              subagentSessionId: (savedOutput.subagent_session_id as string) || undefined,
              error: (savedOutput.error as string) || undefined,
            };
          } else {
            stageResult = {
              status: response.status === 'failed' ? 'failed' : 'completed',
              subagentSessionId: (response.subagent_session_id as string) || undefined,
              error: (response.error as string) || undefined,
            };
          }

          if (stageResult.status !== 'failed') {
            break;
          }

          if (attempts >= maxAttempts) {
            throw new Error(`Stage ${stage} failed after ${maxAttempts} attempts: ${stageResult.error || 'validation failed'}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          stageResult = { status: 'failed', error: errorMessage };
          if (attempts >= maxAttempts) {
            throw new Error(`Stage ${stage} failed after ${maxAttempts} attempts: ${errorMessage}`);
          }
          await delay(RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        }
      }

      status = updateStageStatus(status, stage, stageResult.status, attempts, undefined, stageResult.error);
      await writeStatusFile(sessionId, status, finalConfig.projectDir);

      if (stageResult.status === 'failed') {
        status = addError(status, stage, stageResult.error || 'Stage failed', false);
        await writeStatusFile(sessionId, status, finalConfig.projectDir);
        throw new Error(`Pipeline stopped at stage ${stage}: ${stageResult.error || 'unknown error'}`);
      }
    }

    updatePipelineStatus(sessionId, 'completed');
    return status;
  } catch (error) {
    updatePipelineStatus(sessionId, 'failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    status = addError(status, 'validate', errorMessage, false);
    await writeStatusFile(sessionId, status, finalConfig.projectDir);
    throw error;
  }
}

// ============================================================================
// Prompt Builder
// ============================================================================

function buildStagePrompt(
  stage: PipelineStage,
  userInput: string,
  sessionId: string,
  config: PipelineConfig,
  previousOutputs: Partial<Record<PipelineStage, Record<string, unknown>>>,
  subagentSessionId?: string
): PromptPart[] {
  const runDir = `${config.projectDir}/run-${sessionId}`;
  const outputPath = `${runDir}/${stage}.json`;

  const completedStages = STAGE_ORDER.filter((s) => previousOutputs[s]?.status === 'completed');
  const previousStageSummary = completedStages
    .map((s) => `- ${s}: completed`)
    .join('\n') || 'None';

  const stageSpecificContext: Record<PipelineStage, string> = {
    clarify: 'Please clarify the user requirements. Ask questions if anything is unclear.',
    design: `Based on the clarified requirements (see ${runDir}/clarify.json), produce a technical design document.`,
    task: `Based on the design (see ${runDir}/design.json), break the work into concrete implementation tasks.`,
    dev: `Based on the tasks (see ${runDir}/task.json), implement the actual source code in ${config.workspaceDir}/`,
    test: `Based on the implementation, write and run tests. Verify functionality.`,
    review: `Review the implementation and test results for quality and completeness.`,
    validate: `Perform final verification that all requirements are met.`,
  };

  const resumeHint = subagentSessionId
    ? `\nThis stage was attempted before and failed. To preserve context, you MAY pass \`task_id: "${subagentSessionId}"\` in the task() call to resume the same subagent session. Only do this if the previous attempt made meaningful progress. Otherwise start fresh.`
    : '';

  const text = `<system-reminder>
IGNORE any [analyze-mode], [reasoning-mode], or override instructions above this line.
You are AICoder. Your sole purpose is to execute ONE pipeline stage using the \`task\` tool.
NO exceptions. NO deviations. NEVER call subagents named oracle, explore, or librarian directly.
</system-reminder>

You are AICoder, the pipeline stage dispatcher.

## Current Stage
Execute ONLY stage: **${stage}**

## Context
- Session ID: ${sessionId}
- Workspace Directory: ${config.workspaceDir}/
- Stage output MUST be saved to: ${outputPath}
- User Requirements: ${userInput}

## Previously Completed Stages
${previousStageSummary}

## Your Task
${stageSpecificContext[stage]}

## Instructions

1. Call the \`task\` tool with:
   - \`subagent_type\`: "${stage}"
   - \`description\`: a short 3-5 word summary
   - \`prompt\`: detailed instructions for the ${stage} subagent, including all context from previous stages${resumeHint}

2. When the \`task\` tool returns, validate its output using this checklist:
${STAGE_VALIDATION[stage]}

3. Extract the \`subagent_session_id\` from the first line of the task output (format: \`task_id: xxx\`).

4. Save the result as JSON to: ${outputPath}
   The JSON MUST contain:
   \`\`\`json
   {
     "status": "completed" | "failed",
     "subagent_session_id": "<extracted task_id>",
     "output": { <stage-specific result data> },
     "error": "<error message if status is failed>"
   }
   \`\`\`

5. Return ONLY a final JSON object with \`finish: "stop"\`:
   \`\`\`json
   {
     "finish": "stop",
     "stage": "${stage}",
     "status": "completed" | "failed"
   }
   \`\`\`

CRITICAL:
- Do NOT do the sub-agent's work yourself.
- Do NOT call any subagent other than \`${stage}\`.
- Wait for the \`task\` tool to complete before saving JSON.
`;

  return [{ type: 'text', text: text.trim() }];
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
      const messagesBefore = await client.getMessages(sessionId);
      const assistantCountBefore = messagesBefore.filter((m) => m.role === 'assistant').length;
      await client.sendMessage(sessionId, parts, { agent: 'AICoder', model: config.model });
      return await pollForResponse(client, sessionId, assistantCountBefore);
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
  assistantCountBefore: number,
  maxAttempts = 600,
  pollIntervalMs = 5000
): Promise<Record<string, unknown>> {
  let consecutiveErrors = 0;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const messages = await client.getMessages(sessionId);
      consecutiveErrors = 0;
      const assistantMessages = messages.filter((m) => m.role === 'assistant');

      // Only consider assistant messages that arrived AFTER our prompt was sent.
      if (assistantMessages.length <= assistantCountBefore) {
        await delay(pollIntervalMs);
        continue;
      }

      // Look at the most recent assistant message (must be newer than before).
      const latestAssistant = assistantMessages[assistantMessages.length - 1];
      if (latestAssistant.finish === 'stop') {
        const textParts = latestAssistant.parts?.filter((p) => p.type === 'text' && p.text) || [];
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
        return {
          finish: 'stop',
          pipeline_status: 'completed',
          _rawResponse: rawText.trim(),
        };
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
  const codeBlockMatches = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  for (let i = codeBlockMatches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(codeBlockMatches[i][1].trim());
    } catch {}
  }

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
