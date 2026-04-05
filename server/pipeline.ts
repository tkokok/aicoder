/**
 * Pipeline Orchestration Loop — Plan B (One-Shot Authorization)
 *
 * The backend sends exactly one comprehensive playbook to the AICoder main agent.
 * AICoder autonomously executes all stages via the `task` tool, saves JSON outputs,
 * and narrates its own progress. The backend only polls the filesystem to track
 * progress and detect completion or failure.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { OpenCodeClient } from './opencode';
import { db, transaction } from './db';
import type { PromptPart } from './opencode';
import { buildPipelinePlaybook } from './prompts/pipeline-dispatch';

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

export type PipelineMode = 'full' | 'standard' | 'simple';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StageTiming {
  stage_start_ms: number;
  stage_end_ms?: number;
  total_ms?: number;
}

export interface StageResult {
  status: StageStatus;
  attempts: number;
  output?: string;
  error?: string;
  timing?: StageTiming;
}

export interface PipelineStatus {
  session_id: string;
  pipeline: {
    current_stage: PipelineStage | 'completed' | 'failed';
    started_at: string;
    updated_at: string;
  };
  stage_order: PipelineStage[];
  stages: Record<PipelineStage, StageResult>;
  stage_timings: Partial<Record<PipelineStage, StageTiming>>;
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
  mode?: PipelineMode;
}

interface PipelineCheckpoint {
  version: 1;
  session_id: string;
  mode: PipelineMode;
  stage_order: PipelineStage[];
  current_stage_index: number;
  overall_status: 'running' | 'completed' | 'failed';
  stages: Record<PipelineStage, {
    status: StageStatus;
    attempts: number;
    error?: string;
  }>;
}

// ============================================================================
// Constants
// ============================================================================

const ALL_STAGES: PipelineStage[] = [
  'clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'
];

const STAGE_ORDERS: Record<PipelineMode, PipelineStage[]> = {
  full: ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'],
  standard: ['clarify', 'design', 'dev', 'review'],
  simple: ['clarify', 'dev'],
};

export function getStageOrder(mode: PipelineMode): PipelineStage[] {
  return STAGE_ORDERS[mode] ?? STAGE_ORDERS.standard;
}

const DEFAULT_CONFIG: PipelineConfig = {
  maxRetries: 3,
  retryDelayMs: 2000,
  workspaceDir: './workspace',
  projectDir: './workspace',
  agentsDir: './agents',
};

const RETRY_DELAYS = [2000, 5000, 10000];

// ============================================================================
// Checkpoint I/O
// ============================================================================

function getCheckpointPath(sessionId: string, projectDir: string): string {
  return join(projectDir, `run-${sessionId}`, 'checkpoint.json');
}

async function loadCheckpoint(sessionId: string, projectDir: string): Promise<PipelineCheckpoint | null> {
  try {
    const content = await readFile(getCheckpointPath(sessionId, projectDir), 'utf-8');
    const parsed = JSON.parse(content) as PipelineCheckpoint;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCheckpoint(checkpoint: PipelineCheckpoint, projectDir: string): Promise<void> {
  const path = getCheckpointPath(checkpoint.session_id, projectDir);
  await mkdir(join(projectDir, `run-${checkpoint.session_id}`), { recursive: true });
  await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf-8');
}

function createCheckpoint(sessionId: string, mode: PipelineMode, stageOrder: PipelineStage[]): PipelineCheckpoint {
  const stages: Record<PipelineStage, { status: StageStatus; attempts: number }> = {
    clarify: { status: 'pending', attempts: 0 },
    design: { status: 'pending', attempts: 0 },
    task: { status: 'pending', attempts: 0 },
    dev: { status: 'pending', attempts: 0 },
    test: { status: 'pending', attempts: 0 },
    review: { status: 'pending', attempts: 0 },
    validate: { status: 'pending', attempts: 0 },
  };
  return {
    version: 1,
    session_id: sessionId,
    mode,
    stage_order: stageOrder,
    current_stage_index: 0,
    overall_status: 'running',
    stages,
  };
}

// ============================================================================
// Status Tracking (YAML for UI compatibility)
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
  projectDir: string
): Promise<string> {
  const runDir = join(projectDir, `run-${sessionId}`);
  const statusPath = join(runDir, 'status.yaml');
  await mkdir(runDir, { recursive: true });
  const yaml = statusToYaml(status);
  await writeFile(statusPath, yaml, 'utf-8');
  return statusPath;
}

export async function readStatusFile(
  sessionId: string,
  projectDir: string
): Promise<PipelineStatus | null> {
  const statusPath = join(projectDir, `run-${sessionId}`, 'status.yaml');
  try {
    const content = await readFile(statusPath, 'utf-8');
    return yamlToStatus(content);
  } catch {
    return null;
  }
}

export function createInitialStatus(sessionId: string, stageOrder: PipelineStage[]): PipelineStatus {
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
      current_stage: stageOrder[0] || 'clarify',
      started_at: now,
      updated_at: now,
    },
    stage_order: stageOrder,
    stages,
    stage_timings: {},
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

function statusToYaml(status: PipelineStatus): string {
  const lines: string[] = [
    `session_id: ${status.session_id}`,
    `pipeline:\n  current_stage: ${status.pipeline.current_stage}`,
    `  started_at: ${status.pipeline.started_at}`,
    `  updated_at: ${status.pipeline.updated_at}`,
    `stage_order: [${status.stage_order.join(', ')}]`,
    `stages:`,
  ];
  for (const stage of ALL_STAGES) {
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
  lines.push(`stage_timings:`);
  for (const stage of ALL_STAGES) {
    const t = status.stage_timings[stage];
    lines.push(`  ${stage}:`);
    if (t) {
      lines.push(`    stage_start_ms: ${t.stage_start_ms ?? ''}`);
      lines.push(`    stage_end_ms: ${t.stage_end_ms ?? ''}`);
      lines.push(`    total_ms: ${t.total_ms ?? ''}`);
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
    } else if (trimmed.startsWith('stage_order:')) {
      const arrText = trimmed.slice('stage_order:'.length).trim();
      result.stage_order = (arrText.match(/[a-z]+/g) || []).filter((s) => ALL_STAGES.includes(s as PipelineStage)) as PipelineStage[];
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
      if (trimmed.endsWith(':') && ALL_STAGES.includes(trimmed.slice(0, -1) as PipelineStage)) {
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

function checkpointToPipelineStatus(checkpoint: PipelineCheckpoint): PipelineStatus {
  const status = createInitialStatus(checkpoint.session_id, checkpoint.stage_order);
  status.pipeline.current_stage = checkpoint.stage_order[checkpoint.current_stage_index] || checkpoint.overall_status;
  for (const stage of ALL_STAGES) {
    const cs = checkpoint.stages[stage];
    if (cs) {
      status.stages[stage] = {
        status: cs.status,
        attempts: cs.attempts,
        error: cs.error,
      };
    }
  }
  return status;
}

// ============================================================================
// Stage Output I/O
// ============================================================================

export async function readStageOutput(
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

export async function writeStageOutput(
  sessionId: string,
  stage: PipelineStage,
  projectDir: string,
  data: Record<string, unknown>
): Promise<void> {
  const runDir = join(projectDir, `run-${sessionId}`);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, `${stage}.json`);
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

async function readStageStatuses(
  sessionId: string,
  projectDir: string,
  stageOrder: PipelineStage[]
): Promise<Record<PipelineStage, { exists: boolean; status?: string; error?: string }>> {
  const result = {} as Record<PipelineStage, { exists: boolean; status?: string; error?: string }>;
  for (const stage of stageOrder) {
    const data = await readStageOutput(sessionId, stage, projectDir);
    if (data) {
      result[stage] = {
        exists: true,
        status: (data.status as string) || 'completed',
        error: (data.error as string) || undefined,
      };
    } else {
      result[stage] = { exists: false };
    }
  }
  return result;
}

function inferPipelineStatus(
  stageOrder: PipelineStage[],
  statuses: Record<PipelineStage, { exists: boolean; status?: string; error?: string }>
): 'running' | 'completed' | 'failed' {
  for (const stage of stageOrder) {
    const s = statuses[stage];
    if (!s?.exists) return 'running';
    if (s.status === 'failed') return 'failed';
  }
  return 'completed';
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
  const pipelineMode: PipelineMode = ['full', 'standard', 'simple'].includes(options.mode || '')
    ? (options.mode as PipelineMode)
    : 'standard';
  const stageOrder = getStageOrder(pipelineMode);

  let checkpoint = await loadCheckpoint(sessionId, finalConfig.projectDir);
  if (!checkpoint) {
    checkpoint = createCheckpoint(sessionId, pipelineMode, stageOrder);
  }
  checkpoint.stage_order = stageOrder;
  checkpoint.mode = pipelineMode;

  let status = checkpointToPipelineStatus(checkpoint);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  const playbook = buildPipelinePlaybook({
    mode: pipelineMode,
    stageOrder,
    sessionId,
    projectDir: finalConfig.projectDir,
    workspaceDir: finalConfig.workspaceDir,
    userInput,
  });

  const stageStartTime = Date.now();
  const timing: StageTiming = { stage_start_ms: stageStartTime };
  console.log(`[PIPELINE][${sessionId}] START mode=${pipelineMode} stages=[${stageOrder.join(',')}] at ${new Date(stageStartTime).toISOString()}`);

  try {
    const tSendStart = Date.now();
    await sendPromptWithRetry(
      options.client,
      opencodeSessionId,
      [{ type: 'text', text: playbook }],
      finalConfig
    );
    console.log(`[PIPELINE][${sessionId}] Playbook dispatched in ${Date.now() - tSendStart}ms`);

    const maxIdleMs = 10 * 60 * 1000;
    const pollIntervalMs = 3000;
    let lastProgressMs = Date.now();
    let lastCompletedCount = 0;

    while (true) {
      await delay(pollIntervalMs);

      const stageStatuses = await readStageStatuses(sessionId, finalConfig.projectDir, stageOrder);
      const overall = inferPipelineStatus(stageOrder, stageStatuses);
      const completedCount = stageOrder.filter((s) => stageStatuses[s].exists && stageStatuses[s].status === 'completed').length;

      for (const stage of stageOrder) {
        const s = stageStatuses[stage];
        if (s.exists) {
          checkpoint.stages[stage].status = s.status as StageStatus;
          checkpoint.stages[stage].attempts = Math.max(checkpoint.stages[stage].attempts, 1);
          status.stages[stage].status = s.status as StageStatus;
          if (s.status === 'failed' && s.error) {
            checkpoint.stages[stage].error = s.error;
            status.stages[stage].error = s.error;
          }
        }
      }

      const currentStageName = stageOrder.find((s) => !stageStatuses[s].exists) || 'completed';
      checkpoint.current_stage_index = currentStageName === 'completed'
        ? stageOrder.length
        : stageOrder.indexOf(currentStageName as PipelineStage);
      checkpoint.overall_status = overall;
      await saveCheckpoint(checkpoint, finalConfig.projectDir);

      status.pipeline.current_stage = currentStageName === 'completed' ? 'completed' : currentStageName;
      await writeStatusFile(sessionId, status, finalConfig.projectDir);

      if (overall === 'completed') {
        const stageEndTime = Date.now();
        timing.stage_end_ms = stageEndTime;
        timing.total_ms = stageEndTime - stageStartTime;
        console.log(`[PIPELINE][${sessionId}] COMPLETED total=${timing.total_ms}ms`);
        updatePipelineStatus(sessionId, 'completed');
        return status;
      }

      if (overall === 'failed') {
        const failedStage = stageOrder.find((s) => stageStatuses[s].status === 'failed')!;
        const errorMsg = stageStatuses[failedStage].error || `Stage ${failedStage} failed`;
        status = addError(status, failedStage, errorMsg, false);
        await writeStatusFile(sessionId, status, finalConfig.projectDir);
        updatePipelineStatus(sessionId, 'failed');
        throw new Error(`Pipeline stopped at stage ${failedStage}: ${errorMsg}`);
      }

      if (completedCount > lastCompletedCount) {
        lastProgressMs = Date.now();
        lastCompletedCount = completedCount;
        console.log(`[PIPELINE][${sessionId}] Progress: ${completedCount}/${stageOrder.length} stages completed`);
      } else if (Date.now() - lastProgressMs > maxIdleMs) {
        throw new Error('Pipeline timed out: no stage progress for 10 minutes');
      }
    }
  } catch (error) {
    checkpoint.overall_status = 'failed';
    await saveCheckpoint(checkpoint, finalConfig.projectDir);
    updatePipelineStatus(sessionId, 'failed');
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    status = addError(status, 'validate', errorMessage, false);
    await writeStatusFile(sessionId, status, finalConfig.projectDir);
    throw error;
  }
}

// ============================================================================
// Prompt & Communication
// ============================================================================

async function sendPromptWithRetry(
  client: OpenCodeClient,
  sessionId: string,
  parts: PromptPart[],
  config: PipelineConfig
): Promise<void> {
  let attempt = 0;
  while (attempt < config.maxRetries) {
    attempt++;
    try {
      await client.sendMessage(sessionId, parts, { agent: 'AICoder', model: config.model });
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (attempt < config.maxRetries && isRecoverableError(error)) {
        await delay(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
        continue;
      }
      throw new Error(`Main Agent dispatch failed: ${errorMessage}`);
    }
  }
  throw new Error('Max retries exceeded for Main Agent dispatch');
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

export { ALL_STAGES as STAGE_ORDER, DEFAULT_CONFIG, RETRY_DELAYS };
