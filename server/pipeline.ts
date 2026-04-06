/**
 * Pipeline Orchestration Loop — Phase-Driven State Machine
 *
 * The backend drives the pipeline one phase at a time. It sends a single-phase
 * playbook to the AICoder main agent, waits for it to finish, reads the stage
 * output, then decides the next phase. dev/test/review can loop up to
 * MAX_DEV_ITERATIONS times.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { OpenCodeClient } from './opencode';
import { db, transaction } from './db';
import type { PromptPart } from './opencode';
import { buildPipelinePlaybook, buildPhasePlaybook } from './prompts/pipeline-dispatch';
import { createSessionLogger, logger } from './logger';
import { ALL_STAGES, getStageOrder, DEFAULT_CONFIG, RETRY_DELAYS } from './shared/constants';

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

type Phase = Exclude<PipelineStage, 'task'>;

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
  reasoningEffort?: string;
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
  reasoningEffort?: string;
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
  phase?: Phase | 'completed' | 'failed';
  iteration?: number;
  feedback?: string;
  last_feedback_from?: 'test' | 'review';
}

// ============================================================================
// Constants
// ============================================================================

const MAX_DEV_ITERATIONS = 3;

// Pipeline configuration constants
const PIPELINE_MAX_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const PIPELINE_POLL_INTERVAL_MS = 3000;

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
    phase: (stageOrder[0] as any) || 'completed',
    iteration: 1,
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
  const yamlStr = statusToYaml(status);
  await writeFile(statusPath, yamlStr, 'utf-8');
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
    logger.error('Failed to parse YAML status', error, { component: 'pipeline' });
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
  timeoutMs: number
): Promise<'completed' | 'timeout'> {
  const start = Date.now();
  let hasJson = false;
  let hasFinish = false;

  while (Date.now() - start < timeoutMs) {
    if (!hasJson) {
      try {
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
            ?.filter((p: any) => (p.type === 'text' || p.type === 'reasoning') && p.text)
            .map((p: any) => p.text as string) || [];
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

    await delay(PIPELINE_POLL_INTERVAL_MS);
  }

  return 'timeout';
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
    reasoningEffort: options.reasoningEffort,
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

  // Migrate old checkpoint
  if (!checkpoint.phase) {
    checkpoint.phase = (stageOrder[checkpoint.current_stage_index] as any) || 'completed';
  }
  if (typeof checkpoint.iteration !== 'number') {
    checkpoint.iteration = 1;
  }

  let status = checkpointToPipelineStatus(checkpoint);
  initPipelineStatus(sessionId);
  await writeStatusFile(sessionId, status, finalConfig.projectDir);

  const stageStartTime = Date.now();
  const timing: StageTiming = { stage_start_ms: stageStartTime };
  const sessionLogger = createSessionLogger(sessionId);
  sessionLogger.info(`Pipeline START mode=${pipelineMode} stages=[${stageOrder.join(',')}]`, { operation: 'start' });

  let lastRunningPhase: Phase = (stageOrder[0] as Phase) || 'clarify';

  try {
    let lastProgressMs = Date.now();

    while (true) {
      const phase = checkpoint.phase;
      if (!phase || phase === 'completed' || phase === 'failed') {
        break;
      }

      const stage = phase as PipelineStage;
      lastRunningPhase = stage as any;
      sessionLogger.info(`Phase START phase=${phase} iteration=${checkpoint.iteration}`, { operation: 'phase_start', phase, iteration: checkpoint.iteration });

      // Build and send playbook
      const playbook = buildPhasePlaybook({
        mode: pipelineMode,
        stageOrder,
        sessionId,
        projectDir: finalConfig.projectDir,
        workspaceDir: finalConfig.workspaceDir,
        userInput: userInput || '',
        phase: phase! as Phase,
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
        PIPELINE_MAX_IDLE_MS
      );

      if (waitResult === 'timeout') {
        throw new Error(`Phase ${phase} timed out: no progress for ${PIPELINE_MAX_IDLE_MS / 60000} minutes`);
      }

      // Read stage output
      const stageOutput = await readStageOutput(sessionId, stage, finalConfig.projectDir);
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

      if (stageStatus === 'failed') {
        throw new Error(`Stage ${stage} failed: ${stageError || 'unknown error'}`);
      }

      // Compute next phase
      const next = computeNextPhase(phase, checkpoint.iteration || 1, stageOutput, stageOrder);

      if (next.phase === 'failed') {
        throw new Error(next.feedback || `Phase ${phase} failed`);
      }

      checkpoint.phase = next.phase;
      checkpoint.iteration = next.iteration;
      checkpoint.feedback = next.feedback;
      checkpoint.last_feedback_from = next.lastFeedbackFrom;

      const idx = stageOrder.indexOf(next.phase as PipelineStage);
      checkpoint.current_stage_index = idx >= 0 ? idx : stageOrder.length;
      await saveCheckpoint(checkpoint, finalConfig.projectDir);

      lastProgressMs = Date.now();

      if (next.phase === 'completed') {
        break;
      }
    }

    const stageEndTime = Date.now();
    timing.stage_end_ms = stageEndTime;
    timing.total_ms = stageEndTime - stageStartTime;

    checkpoint.overall_status = 'completed';
    checkpoint.phase = 'completed';
    await saveCheckpoint(checkpoint, finalConfig.projectDir);

    sessionLogger.info(`Pipeline COMPLETED total=${timing.total_ms}ms`, { operation: 'complete' });
    updatePipelineStatus(sessionId, 'completed');
    return status;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    checkpoint.overall_status = 'failed';
    checkpoint.phase = 'failed';
    await saveCheckpoint(checkpoint, finalConfig.projectDir);
    updatePipelineStatus(sessionId, 'failed');
    const currentStage = lastRunningPhase || stageOrder[stageOrder.length - 1];
    status = addError(status, currentStage as PipelineStage, errorMessage, false);
    await writeStatusFile(sessionId, status, finalConfig.projectDir);
    sessionLogger.error('Pipeline failed', error, { stage: currentStage, operation: 'error' });
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
