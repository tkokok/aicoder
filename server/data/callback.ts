import type {
  StageCompleteCallback,
  PipelineCompleteCallback,
  PipelineStatusUpdateCallback,
  SSEForwardCallback,
} from '../shared/types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('data-callback');

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:8080';
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;

async function notifyControlPlane(path: string, payload: unknown): Promise<void> {
  const url = `${CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': CALLBACK_TOKEN ? `Bearer ${CALLBACK_TOKEN}` : '',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      log.error(`Callback failed: ${response.status} ${text}`, undefined, { path, status: response.status });
    }
  } catch (error) {
    log.error('Failed to send callback', error, { path });
  }
}

export async function notifyStageComplete(event: StageCompleteCallback): Promise<void> {
  await notifyControlPlane('/api/internal/stage-complete', event);
}

export async function notifyPipelineComplete(event: PipelineCompleteCallback): Promise<void> {
  await notifyControlPlane('/api/internal/pipeline-complete', event);
}

export async function notifyPipelineStatus(event: PipelineStatusUpdateCallback): Promise<void> {
  await notifyControlPlane('/api/internal/pipeline-status', event);
}

export async function notifySSEEvent(event: SSEForwardCallback): Promise<void> {
  await notifyControlPlane('/api/internal/sse-event', event);
}
