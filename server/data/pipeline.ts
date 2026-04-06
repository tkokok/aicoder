/**
 * Pipeline Orchestration Loop — Data Plane
 *
 * The data plane receives the playbook from control plane,
 * dispatches it to OpenCode, then monitors local filesystem
 * for stage outputs and reports progress via callbacks.
 */

import { join } from 'path';
import * as yaml from 'js-yaml';
import { OpenCodeClient } from './opencode.js';
import type {
  PipelineStage,
  PipelineMode,
  StageStatus,
  StageTiming,
  StageResult,
  PipelineStatus,
  PipelineCheckpoint,
  PromptPart,
} from '../shared/types.js';
import {
  ALL_STAGES,
  getStageOrder,
  DEFAULT_CONFIG,
  RETRY_DELAYS,
  PIPELINE_MAX_IDLE_MS,
} from '../shared/constants.js';
import { buildPipelinePlaybook } from '../prompts/pipeline-dispatch.js';
import { createSessionLogger, logger } from '../logger.js';
import { LocalFileSystem } from './filesystem.js';
import { notifyStageComplete, notifyPipelineComplete, notifyPipelineStatus, notifyMessageUpdate } from './callback.js';

// ============================================================================
// Types
// ============================================================================

export interface PipelineConfig {
  maxRetries: number;
  retryDelayMs: number;
  workspaceDir: string;
  projectDir: string;
  agentsDir: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ExecutePipelineOptions {
  sessionId: string;
  opencodeSessionId: string;
  userInput?: string;
  playbook?: string;
  workspaceDir: string;
  projectDir: string;
  client: OpenCodeClient;
  agentsDir?: string;
  model?: string;
  mode?: PipelineMode;
  reasoningEffort?: string;
}

interface ActivePipeline {
  stop: () => void;
  sessionId: string;
}

// ============================================================================
// Constants
// ============================================================================

const activePipelines = new Map<string, ActivePipeline>();

// ============================================================================
// Checkpoint I/O
// ============================================================================

function getCheckpointPath(sessionId: string, projectDir: string): string {
  return join(projectDir, `run-${sessionId}`, 'checkpoint.json');
}

async function loadCheckpoint(sessionId: string, projectDir: string): Promise<PipelineCheckpoint | null> {
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(getCheckpointPath(sessionId, projectDir), 'utf-8');
    const parsed = JSON.parse(content) as PipelineCheckpoint;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveCheckpoint(checkpoint: PipelineCheckpoint, projectDir: string): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises');
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
  const stageExecutions: Record<PipelineStage, number> = {
    clarify: 0,
    design: 0,
    task: 0,
    dev: 0,
    test: 0,
    review: 0,
    validate: 0,
  };
  return {
    version: 1,
    session_id: sessionId,
    mode,
    stage_order: stageOrder,
    current_stage_index: 0,
    overall_status: 'running',
    stages,
    stage_executions: stageExecutions,
    iteration: 1,
  };
}

// ============================================================================
// Status Tracking (YAML for UI compatibility)
// ============================================================================

export async function writeStatusFile(
  sessionId: string,
  status: PipelineStatus,
  projectDir: string
): Promise<string> {
  const { writeFile, mkdir } = await import('fs/promises');
  const runDir = join(projectDir, `run-${sessionId}`);
  const statusPath = join(runDir, 'status.yaml');
  await mkdir(runDir, { recursive: true });
  const yamlStr = statusToYaml(status);
  await writeFile(statusPath, yamlStr, 'utf-8');
  return statusPath;
}

export async function readStatusFile(
  sessionId: string,
  projectDir: string
): Promise<PipelineStatus | null> {
  const { readFile } = await import('fs/promises');
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
  return yaml.dump(status, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}

function yamlToStatus(yamlContent: string): PipelineStatus {
  try {
    const parsed = yaml.load(yamlContent) as Partial<PipelineStatus>;
    const stages: Record<PipelineStage, StageResult> = {
      clarify: { status: 'pending', attempts: 0 },
      design: { status: 'pending', attempts: 0 },
      task: { status: 'pending', attempts: 0 },
      dev: { status: 'pending', attempts: 0 },
      test: { status: 'pending', attempts: 0 },
      review: { status: 'pending', attempts: 0 },
      validate: { status: 'pending', attempts: 0 },
    };
    if (parsed.stages) {
      for (const stage of ALL_STAGES) {
        if (parsed.stages[stage]) {
          stages[stage] = parsed.stages[stage];
        }
      }
    }
    return {
      session_id: parsed.session_id || '',
      pipeline: parsed.pipeline || {
        current_stage: 'clarify',
        started_at: '',
        updated_at: '',
      },
      stage_order: parsed.stage_order || ALL_STAGES,
      stages,
      stage_timings: parsed.stage_timings || {},
      errors: parsed.errors || [],
    };
  } catch (error) {
    logger.error('Failed to parse YAML status', error, { component: 'data-pipeline' });
    return createInitialStatus('unknown', ALL_STAGES);
  }
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
// Main Orchestration
// ============================================================================

export async function executePipeline(options: ExecutePipelineOptions): Promise<{ stop: () => void }> {
  const finalConfig: PipelineConfig = {
    ...DEFAULT_CONFIG,
    workspaceDir: options.workspaceDir,
    projectDir: options.projectDir,
    agentsDir: options.agentsDir ?? DEFAULT_CONFIG.agentsDir,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  };

  const sessionId = options.sessionId;
  const opencodeSessionId = options.opencodeSessionId;
  const userInput = options.userInput;
  const pipelineMode: PipelineMode = ['full', 'standard', 'simple'].includes(options.mode || '')
    ? (options.mode as PipelineMode)
    : 'standard';
  const stageOrder = getStageOrder(pipelineMode);

  const fs = new LocalFileSystem(finalConfig.projectDir);

  let checkpoint = await loadCheckpoint(sessionId, finalConfig.projectDir);
  if (!checkpoint) {
    checkpoint = createCheckpoint(sessionId, pipelineMode, stageOrder);
  }
  checkpoint.stage_order = stageOrder;
  checkpoint.mode = pipelineMode;

  let status = checkpointToPipelineStatus(checkpoint);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  const playbook = options.playbook || buildPipelinePlaybook({
    mode: pipelineMode,
    stageOrder,
    sessionId,
    projectDir: finalConfig.projectDir,
    workspaceDir: finalConfig.workspaceDir,
    userInput: userInput || '',
  });

  const stageStartTime = Date.now();
  const timing: StageTiming = { stage_start_ms: stageStartTime };
  const sessionLogger = createSessionLogger(sessionId);
  sessionLogger.info(`Pipeline START mode=${pipelineMode} stages=[${stageOrder.join(',')}]`, { operation: 'start' });

  let completed = false;
  let lastProgressMs = Date.now();
  let lastCompletedCount = 0;
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;
  let messagePollTimer: ReturnType<typeof setInterval> | null = null;
  let stopWatcher: (() => void) | null = null;

  const cleanup = () => {
    if (timeoutTimer) {
      clearInterval(timeoutTimer);
      timeoutTimer = null;
    }
    if (messagePollTimer) {
      clearInterval(messagePollTimer);
      messagePollTimer = null;
    }
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
    activePipelines.delete(sessionId);
  };

  const finishPipeline = async (overallStatus: 'completed' | 'failed', errorMsg?: string) => {
    if (completed) return;
    completed = true;
    cleanup();

    const stageEndTime = Date.now();
    timing.stage_end_ms = stageEndTime;
    timing.total_ms = stageEndTime - stageStartTime;

    checkpoint.overall_status = overallStatus;
    await saveCheckpoint(checkpoint, finalConfig.projectDir);

    if (overallStatus === 'completed') {
      sessionLogger.info(`Pipeline COMPLETED total=${timing.total_ms}ms`, { operation: 'complete' });
    } else {
      const currentStage = checkpoint.current_stage_index < stageOrder.length
        ? stageOrder[checkpoint.current_stage_index]
        : stageOrder[stageOrder.length - 1];
      status = addError(status, currentStage, errorMsg || 'Pipeline failed', false);
      await writeStatusFile(sessionId, status, finalConfig.projectDir);
      sessionLogger.error(`Pipeline FAILED: ${errorMsg}`, new Error(errorMsg || 'Pipeline failed'), { operation: 'fail' });
    }

    await notifyPipelineComplete({
      sessionId,
      status: overallStatus,
      error: errorMsg,
      timestamp: Date.now(),
    });
  };

  // Watch filesystem for stage outputs
  stopWatcher = await fs.watchPipeline(sessionId, async (stageName, data) => {
    if (completed) return;

    const stage = stageName as PipelineStage;
    // Guard against non-stage JSON files (e.g. task-plan.json)
    if (!checkpoint.stages[stage]) {
      sessionLogger.debug(`Ignoring non-stage file: ${stageName}.json`, { operation: 'ignore_file', file: `${stageName}.json` });
      return;
    }

    const stageStatus = (data.status as StageStatus) || 'completed';
    const stageError = (data.error as string) || undefined;

    checkpoint.stages[stage].status = stageStatus;
    checkpoint.stages[stage].attempts = Math.max(checkpoint.stages[stage].attempts, 1);
    if (stageError) {
      checkpoint.stages[stage].error = stageError;
    }
    // Track stage execution count for dev/test/review loops
    if (!checkpoint.stage_executions) {
      checkpoint.stage_executions = {} as Record<PipelineStage, number>;
    }
    checkpoint.stage_executions[stage] = (checkpoint.stage_executions[stage] || 0) + 1;

    status = updateStageStatus(status, stage, stageStatus, checkpoint.stages[stage].attempts, undefined, stageError);
    await saveCheckpoint(checkpoint, finalConfig.projectDir);
    await writeStatusFile(sessionId, status, finalConfig.projectDir);

    // Notify control plane
    const notifyStatus: 'completed' | 'failed' = stageStatus === 'failed' ? 'failed' : 'completed';
    await notifyStageComplete({
      sessionId,
      stage,
      status: notifyStatus,
      output: (data.output as Record<string, unknown>) || {},
      error: stageError,
      timestamp: Date.now(),
    });

    // Determine current stage
    // For dev/test/review loops: only advance index if this stage hasn't been seen before
    // AICoder controls the loop logic; data plane just tracks progress
    const executionCount = checkpoint.stage_executions?.[stage] || 0;
    let currentStageIndex = checkpoint.current_stage_index;

    if (executionCount === 1) {
      // First time seeing this stage - advance index
      const stageIndex = stageOrder.indexOf(stage);
      if (stageIndex >= currentStageIndex) {
        currentStageIndex = stageIndex + 1;
      }
    }
    // If executionCount > 1, this is a rework iteration, don't advance index
    // AICoder will handle the loop logic

    checkpoint.current_stage_index = Math.min(currentStageIndex, stageOrder.length);
    await saveCheckpoint(checkpoint, finalConfig.projectDir);

    const currentStageName = checkpoint.current_stage_index >= stageOrder.length ? 'completed' : stageOrder[checkpoint.current_stage_index];
    status.pipeline.current_stage = currentStageName;
    await writeStatusFile(sessionId, status, finalConfig.projectDir);

    // Send status update
    await notifyPipelineStatus({
      sessionId,
      currentStage: currentStageName,
      overallStatus: 'running',
      stages: Object.fromEntries(
        stageOrder.map((s) => [s, {
          status: checkpoint.stages[s].status,
          attempts: checkpoint.stages[s].attempts,
          error: checkpoint.stages[s].error,
        }])
      ),
      timestamp: Date.now(),
    });

    const completedCount = stageOrder.filter((s) => checkpoint.stages[s].status === 'completed').length;

    if (completedCount === stageOrder.length) {
      await finishPipeline('completed');
      return;
    }

    if (stageStatus === 'failed') {
      await finishPipeline('failed', stageError || `Stage ${stage} failed`);
      return;
    }

    if (completedCount > lastCompletedCount) {
      lastProgressMs = Date.now();
      lastCompletedCount = completedCount;
      sessionLogger.info(`Progress: ${completedCount}/${stageOrder.length} stages completed`, { operation: 'progress' });
    }
  });

  // Idle timeout check
  timeoutTimer = setInterval(() => {
    if (completed) return;
    if (Date.now() - lastProgressMs > PIPELINE_MAX_IDLE_MS) {
      const timeoutError = `Pipeline timed out: no stage progress for ${PIPELINE_MAX_IDLE_MS / 60000} minutes`;
      sessionLogger.error('Pipeline timeout', new Error(timeoutError), { operation: 'timeout' });
      finishPipeline('failed', timeoutError).catch(() => {});
    }
  }, 10000);

  // Message polling to forward activity to control plane
  const MAX_STORED_MESSAGES = 1000;
  const accumulatedMessages: string[] = [];
  const seenMessageTexts = new Set<string>();
  let lastMessagesJson = '';

  const pollMessages = async () => {
    if (completed) return;
    try {
      const rawMessages = await options.client.getMessages(opencodeSessionId);
      let hasNew = false;
      for (const msg of rawMessages) {
        const textParts = msg.parts
          ?.filter((p) => (p.type === 'text' || p.type === 'reasoning') && p.text)
          .map((p) => p.text as string);
        const joined = textParts?.join('\n').trim() || '';
        if (joined && !seenMessageTexts.has(joined)) {
          seenMessageTexts.add(joined);
          accumulatedMessages.push(joined);
          if (accumulatedMessages.length > MAX_STORED_MESSAGES) {
            const removed = accumulatedMessages.shift();
            if (removed) seenMessageTexts.delete(removed);
          }
          hasNew = true;
        }
      }
      const messagesJson = JSON.stringify(accumulatedMessages);
      if (hasNew || messagesJson !== lastMessagesJson) {
        lastMessagesJson = messagesJson;
        const latestMessage = accumulatedMessages.length > 0
          ? accumulatedMessages[accumulatedMessages.length - 1].slice(0, 800)
          : '';
        await notifyMessageUpdate({
          sessionId,
          messages: rawMessages,
          latestMessage,
          messagesJson,
          timestamp: Date.now(),
        });
      }
    } catch {
      // ignore message polling errors
    }
  };

  messagePollTimer = setInterval(() => {
    pollMessages().catch(() => {});
  }, 3000);

  // Notify control plane that pipeline is running
  await notifyPipelineStatus({
    sessionId,
    currentStage: stageOrder[0] || 'completed',
    overallStatus: 'running',
    stages: Object.fromEntries(
      stageOrder.map((s) => [s, {
        status: checkpoint.stages[s].status,
        attempts: checkpoint.stages[s].attempts,
        error: checkpoint.stages[s].error,
      }])
    ),
    timestamp: Date.now(),
  });

  // Send playbook
  try {
    const tSendStart = Date.now();
    await sendPromptWithRetry(
      options.client,
      opencodeSessionId,
      [{ type: 'text', text: playbook }],
      finalConfig
    );
    sessionLogger.info(`Playbook dispatched in ${Date.now() - tSendStart}ms`, { operation: 'dispatch' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    sessionLogger.error('Failed to dispatch playbook', error, { operation: 'dispatch_fail' });
    finishPipeline('failed', errorMessage).catch(() => {});
  }

  activePipelines.set(sessionId, { stop: cleanup, sessionId });

  return {
    stop: cleanup,
  };
}

export function stopPipeline(sessionId: string): void {
  const active = activePipelines.get(sessionId);
  if (active) {
    active.stop();
    activePipelines.delete(sessionId);
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
      await client.sendMessage(sessionId, parts, { agent: 'AICoder', model: config.model, reasoningEffort: config.reasoningEffort });
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
