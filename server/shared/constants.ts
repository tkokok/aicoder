import type { PipelineStage, PipelineMode, PipelineConfig } from './types.js';

export const ALL_STAGES: PipelineStage[] = [
  'clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'
];

const STAGE_ORDERS: Record<PipelineMode, PipelineStage[]> = {
  full: ['clarify', 'design', 'dev', 'test', 'review', 'validate'],
  standard: ['clarify', 'design', 'dev', 'test', 'review'],
  simple: ['clarify', 'design', 'dev'],
};

export function getStageOrder(mode: PipelineMode): PipelineStage[] {
  return STAGE_ORDERS[mode] ?? STAGE_ORDERS.standard;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  maxRetries: 3,
  retryDelayMs: 2000,
  workspaceDir: './workspace',
  projectDir: './workspace',
  agentsDir: './agents',
};

export const RETRY_DELAYS = [2000, 5000, 10000];

export const PIPELINE_MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutes
export const PIPELINE_POLL_INTERVAL_MS = 3000;
