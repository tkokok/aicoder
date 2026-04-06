// ============================================================================
// Pipeline Types
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
  reasoningEffort?: string;
}

export type Phase =
  | 'clarify'
  | 'design'
  | 'dev'
  | 'test'
  | 'review'
  | 'validate';

export interface PipelineCheckpoint {
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
  /** Current phase being executed (post-refactor). */
  phase?: Phase | 'completed' | 'failed';
  /** Iteration count for the dev→test→review loop (starts at 1). */
  iteration?: number;
  /** Feedback summary passed to the next dev phase. */
  feedback?: string;
  /** Which phase produced the feedback ('test' or 'review'). */
  last_feedback_from?: 'test' | 'review';
  /** Track execution count for each stage (supports dev/test/review loops). */
  stage_executions?: Record<PipelineStage, number>;
}

// ============================================================================
// OpenCode Types
// ============================================================================

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

export interface MessagePart {
  type: string;
  text?: string;
}

export interface MessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  finish?: string;
  time: { created: number };
}

export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; url: string; mime?: string; filename?: string };

export interface ModelInfo {
  id: string;
  name: string;
  providerID: string;
}

export interface OpenCodeClientAuth {
  username: string;
  password: string;
}

// ============================================================================
// Data Plane API Types
// ============================================================================

export interface StartPipelineRequest {
  sessionId: string;
  opencodeSessionId: string;
  playbook?: string;
  workspaceDir: string;
  projectDir: string;
  mode: PipelineMode;
  model?: string;
  reasoningEffort?: string;
}

export interface StartPipelineResponse {
  pipelineId: string;
  opencodeSessionId: string;
  opencodeUrl: string;
  status: 'started' | 'failed';
  error?: string;
}

export interface StageOutputResponse {
  status: 'completed' | 'failed' | 'pending';
  output?: Record<string, unknown>;
  error?: string;
  timestamp: number;
}

// ============================================================================
// Callback Types (Data Plane -> Control Plane)
// ============================================================================

export interface StageCompleteCallback {
  sessionId: string;
  stage: PipelineStage;
  status: 'completed' | 'failed';
  output: Record<string, unknown>;
  error?: string;
  timestamp: number;
}

export interface PipelineCompleteCallback {
  sessionId: string;
  status: 'completed' | 'failed';
  error?: string;
  timestamp: number;
}

export interface PipelineStatusUpdateCallback {
  sessionId: string;
  currentStage: string;
  overallStatus: 'running' | 'completed' | 'failed';
  stages: Record<string, { status: string; attempts: number; error?: string }>;
  timestamp: number;
}

export interface SSEForwardCallback {
  sessionId: string;
  event: SSEEvent;
  timestamp: number;
}

export interface MessageUpdateCallback {
  sessionId: string;
  messages: MessageInfo[];
  latestMessage: string;
  messagesJson: string;
  timestamp: number;
}
