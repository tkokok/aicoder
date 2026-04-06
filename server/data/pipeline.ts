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
  Phase,
} from '../shared/types.js';
import {
  ALL_STAGES,
  getStageOrder,
  DEFAULT_CONFIG,
  RETRY_DELAYS,
  PIPELINE_MAX_IDLE_MS,
} from '../shared/constants.js';
import { buildPipelinePlaybook, buildPhasePlaybook } from '../prompts/pipeline-dispatch.js';
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
const MAX_DEV_ITERATIONS = 3;

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
  return {
    version: 1,
    session_id: sessionId,
    mode,
    stage_order: stageOrder,
    current_stage_index: 0,
    overall_status: 'running',
    stages,
    phase: (stageOrder[0] as Phase) || 'completed',
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
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(join(projectDir, `run-${sessionId}`, 'status.yaml'), 'utf-8');
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
  const currentStage = checkpoint.phase && checkpoint.phase !== 'completed' && checkpoint.phase !== 'failed'
    ? checkpoint.phase
    : checkpoint.stage_order[checkpoint.current_stage_index] || checkpoint.overall_status;
  status.pipeline.current_stage = currentStage;
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
// Phase Logic
// ============================================================================

function detectTestFailures(output: Record<string, unknown> | null): boolean {
  if (!output) return false;
  const failed = Array.isArray(output.failed_tests) && output.failed_tests.length > 0;
  const gaps = output.gaps as any[];
  const criticalGaps = Array.isArray(gaps) && gaps.some((g) => g && (g.severity === 'critical' || g.severity === 'high'));
  const exec = output.test_execution as any;
  const allPassed = exec && typeof exec.total === 'number' && typeof exec.passed === 'number' && exec.total > 0 && exec.passed === exec.total;
  return failed || criticalGaps || !allPassed;
}

function detectReviewApproval(output: Record<string, unknown> | null): boolean {
  return output?.approved === true;
}

function summarizeTestFailures(output: Record<string, unknown> | null): string {
  if (!output) return 'Test phase reported failures.';
  const parts: string[] = [];
  const failed = output.failed_tests as any[];
  if (Array.isArray(failed) && failed.length > 0) {
    parts.push(`Failed tests: ${failed.map((f) => (typeof f === 'string' ? f : f.name || f.test || JSON.stringify(f))).join(', ')}`);
  }
  const gaps = output.gaps as any[];
  if (Array.isArray(gaps) && gaps.length > 0) {
    parts.push(`Coverage gaps: ${gaps.map((g) => (typeof g === 'string' ? g : g.description || JSON.stringify(g))).join('; ')}`);
  }
  return parts.join('. ') || 'Tests did not fully pass. Please review and fix implementation issues.';
}

function summarizeReviewIssues(output: Record<string, unknown> | null): string {
  if (!output) return 'Review phase reported issues.';
  const parts: string[] = [];
  const blockers = output.blockers as any[];
  if (Array.isArray(blockers) && blockers.length > 0) {
    parts.push(`Blockers: ${blockers.map((b) => (typeof b === 'string' ? b : b.description || JSON.stringify(b))).join(', ')}`);
  }
  const issues = output.issues as any[];
  if (Array.isArray(issues) && issues.length > 0) {
    const top = issues.slice(0, 3).map((i) => `${i.severity || 'issue'}${i.file ? ` in ${i.file}` : ''}: ${i.description || JSON.stringify(i)}`);
    parts.push(`Issues: ${top.join('; ')}`);
  }
  return parts.join('. ') || 'Code review identified problems that need to be addressed.';
}

function computeNextPhase(
  currentPhase: Phase,
  iteration: number,
  stageOutput: Record<string, unknown> | null,
  stageOrder: PipelineStage[]
): { phase: Phase | 'completed' | 'failed'; iteration: number; feedback?: string; lastFeedbackFrom?: 'test' | 'review' } {
  if (currentPhase === 'clarify') return { phase: 'design', iteration };
  if (currentPhase === 'design') return { phase: 'dev', iteration };

  if (currentPhase === 'dev') {
    return { phase: 'test', iteration };
  }

  if (currentPhase === 'test') {
    const hasFailures = detectTestFailures(stageOutput);
    if (hasFailures) {
      if (iteration >= MAX_DEV_ITERATIONS) {
        return { phase: 'failed', iteration, feedback: `Max iterations (${MAX_DEV_ITERATIONS}) exceeded after test failures.` };
      }
      return {
        phase: 'dev',
        iteration: iteration + 1,
        feedback: summarizeTestFailures(stageOutput),
        lastFeedbackFrom: 'test',
      };
    }
    return { phase: 'review', iteration };
  }

  if (currentPhase === 'review') {
    const approved = detectReviewApproval(stageOutput);
    if (!approved) {
      if (iteration >= MAX_DEV_ITERATIONS) {
        return { phase: 'failed', iteration, feedback: `Max iterations (${MAX_DEV_ITERATIONS}) exceeded after review rejection.` };
      }
      return {
        phase: 'dev',
        iteration: iteration + 1,
        feedback: summarizeReviewIssues(stageOutput),
        lastFeedbackFrom: 'review',
      };
    }
    const hasValidate = stageOrder.includes('validate');
    return { phase: hasValidate ? 'validate' : 'completed', iteration };
  }

  if (currentPhase === 'validate') {
    return { phase: 'completed', iteration };
  }

  return { phase: 'completed', iteration };
}

// ============================================================================
// Phase Completion Detection
// ============================================================================

async function waitForPhaseCompletion(
  client: OpenCodeClient,
  opencodeSessionId: string,
  expectedPhase: Phase,
  projectDir: string,
  sessionId: string,
  timeoutMs: number,
  shouldStop: () => boolean
): Promise<'completed' | 'stopped' | 'timeout'> {
  const start = Date.now();
  let hasJson = false;
  let hasFinish = false;

  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) return 'stopped';

    if (!hasJson) {
      try {
        const { readFile } = await import('fs/promises');
        const content = await readFile(join(projectDir, `run-${sessionId}`, `${expectedPhase}.json`), 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed && typeof parsed.status === 'string') {
          hasJson = true;
        }
      } catch {
        // ignore
      }
    }

    if (!hasFinish) {
      try {
        const messages = await client.getMessages(opencodeSessionId);
        for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
          const msg = messages[i];
          const textParts = msg.parts
            ?.filter((p) => (p.type === 'text' || p.type === 'reasoning') && p.text)
            .map((p) => p.text as string) || [];
          const joined = textParts.join('\n');
          if (/finish\s*[=:]\s*["']stop["']/i.test(joined)) {
            hasFinish = true;
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    if (hasJson && hasFinish) {
      return 'completed';
    }

    await delay(2000);
  }

  return 'timeout';
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

  // Migrate old checkpoint
  if (!checkpoint.phase) {
    checkpoint.phase = (stageOrder[checkpoint.current_stage_index] as Phase) || 'completed';
  }
  if (typeof checkpoint.iteration !== 'number') {
    checkpoint.iteration = 1;
  }

  let status = checkpointToPipelineStatus(checkpoint);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  const stageStartTime = Date.now();
  const timing: StageTiming = { stage_start_ms: stageStartTime };
  const sessionLogger = createSessionLogger(sessionId);
  sessionLogger.info(`Pipeline START mode=${pipelineMode} stages=[${stageOrder.join(',')}]`, { operation: 'start' });

  let completed = false;
  let lastProgressMs = Date.now();
  let timeoutTimer: ReturnType<typeof setInterval> | null = null;
  let messagePollTimer: ReturnType<typeof setInterval> | null = null;
  let shouldStopFlag = false;

  const cleanup = () => {
    if (timeoutTimer) {
      clearInterval(timeoutTimer);
      timeoutTimer = null;
    }
    if (messagePollTimer) {
      clearInterval(messagePollTimer);
      messagePollTimer = null;
    }
    activePipelines.delete(sessionId);
  };

  const shouldStop = () => completed || shouldStopFlag;

  const finishPipeline = async (overallStatus: 'completed' | 'failed', errorMsg?: string) => {
    if (completed) return;
    completed = true;
    cleanup();

    const stageEndTime = Date.now();
    timing.stage_end_ms = stageEndTime;
    timing.total_ms = stageEndTime - stageStartTime;

    checkpoint.overall_status = overallStatus;
    checkpoint.phase = overallStatus;
    await saveCheckpoint(checkpoint, finalConfig.projectDir);

    if (overallStatus === 'completed') {
      sessionLogger.info(`Pipeline COMPLETED total=${timing.total_ms}ms`, { operation: 'complete' });
    } else {
      const currentStage = checkpoint.phase && checkpoint.phase !== 'completed' && checkpoint.phase !== 'failed'
        ? checkpoint.phase
        : stageOrder[stageOrder.length - 1];
      status = addError(status, currentStage as PipelineStage, errorMsg || 'Pipeline failed', false);
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
    currentStage: checkpoint.phase && checkpoint.phase !== 'completed' && checkpoint.phase !== 'failed'
      ? checkpoint.phase
      : stageOrder[0] || 'completed',
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

  // Phase loop
  (async () => {
    try {
      while (!shouldStop()) {
        const phase = checkpoint.phase;
        if (!phase || phase === 'completed' || phase === 'failed') {
          break;
        }

        const stage = phase as PipelineStage;
        sessionLogger.info(`Phase START phase=${phase} iteration=${checkpoint.iteration}`, { operation: 'phase_start', phase, iteration: checkpoint.iteration });

        // Build and send playbook
        const playbook = options.playbook || buildPhasePlaybook({
          mode: pipelineMode,
          stageOrder,
          sessionId,
          projectDir: finalConfig.projectDir,
          workspaceDir: finalConfig.workspaceDir,
          userInput: userInput || '',
          phase,
          iteration: checkpoint.iteration || 1,
          feedback: checkpoint.feedback,
          lastFeedbackFrom: checkpoint.last_feedback_from,
        });

        const tSendStart = Date.now();
        await sendPromptWithRetry(
          options.client,
          opencodeSessionId,
          [{ type: 'text', text: playbook }],
          finalConfig
        );
        sessionLogger.info(`Playbook dispatched in ${Date.now() - tSendStart}ms`, { operation: 'dispatch', phase });

        // Wait for phase completion
        const waitResult = await waitForPhaseCompletion(
          options.client,
          opencodeSessionId,
          phase,
          finalConfig.projectDir,
          sessionId,
          PIPELINE_MAX_IDLE_MS,
          shouldStop
        );

        if (waitResult === 'stopped') {
          sessionLogger.info('Pipeline stopped by user', { operation: 'stop' });
          return;
        }

        if (waitResult === 'timeout') {
          throw new Error(`Phase ${phase} timed out: no progress for ${PIPELINE_MAX_IDLE_MS / 60000} minutes`);
        }

        // Read stage output
        const stageOutput = await fs.readStageOutput(sessionId, stage);
        const stageStatus = (stageOutput?.status as StageStatus) || 'completed';
        const stageError = (stageOutput?.error as string) || undefined;

        checkpoint.stages[stage].status = stageStatus;
        checkpoint.stages[stage].attempts = Math.max(checkpoint.stages[stage].attempts, 1);
        if (stageError) {
          checkpoint.stages[stage].error = stageError;
        }

        status = updateStageStatus(status, stage, stageStatus, checkpoint.stages[stage].attempts, undefined, stageError);
        await saveCheckpoint(checkpoint, finalConfig.projectDir);
        await writeStatusFile(sessionId, status, finalConfig.projectDir);

        // Notify stage complete
        await notifyStageComplete({
          sessionId,
          stage,
          status: stageStatus === 'failed' ? 'failed' : 'completed',
          output: (stageOutput?.output as Record<string, unknown>) || {},
          error: stageError,
          timestamp: Date.now(),
        });

        if (stageStatus === 'failed') {
          await finishPipeline('failed', stageError || `Stage ${stage} failed`);
          return;
        }

        // Compute next phase
        const next = computeNextPhase(phase, checkpoint.iteration || 1, stageOutput, stageOrder);

        if (next.phase === 'failed') {
          await finishPipeline('failed', next.feedback || `Phase ${phase} failed`);
          return;
        }

        checkpoint.phase = next.phase;
        checkpoint.iteration = next.iteration;
        checkpoint.feedback = next.feedback;
        checkpoint.last_feedback_from = next.lastFeedbackFrom;

        // Update current_stage_index for compatibility
        const idx = stageOrder.indexOf(next.phase as PipelineStage);
        checkpoint.current_stage_index = idx >= 0 ? idx : stageOrder.length;
        await saveCheckpoint(checkpoint, finalConfig.projectDir);

        lastProgressMs = Date.now();

        if (next.phase === 'completed') {
          await finishPipeline('completed');
          return;
        }

        // Notify pipeline status for next phase
        await notifyPipelineStatus({
          sessionId,
          currentStage: next.phase,
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
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sessionLogger.error('Pipeline error', error, { operation: 'error' });
      await finishPipeline('failed', errorMessage);
    }
  })();

  activePipelines.set(sessionId, { stop: () => { shouldStopFlag = true; cleanup(); }, sessionId });

  return {
    stop: () => { shouldStopFlag = true; cleanup(); },
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
