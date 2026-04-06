import type {
  StageCompleteCallback,
  PipelineCompleteCallback,
  PipelineStatusUpdateCallback,
  SSEForwardCallback,
  MessageUpdateCallback,
} from '../shared/types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('data-callback');

// Ensure localhost callbacks bypass any system HTTP proxy
if (!process.env.NO_PROXY?.includes('localhost') && !process.env.NO_PROXY?.includes('127.0.0.1')) {
  const existing = process.env.NO_PROXY || '';
  process.env.NO_PROXY = existing ? `${existing},localhost,127.0.0.1` : 'localhost,127.0.0.1';
}

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || 'http://localhost:8080';
const CALLBACK_TOKEN = process.env.CALLBACK_TOKEN;

async function notifyControlPlane(path: string, payload: unknown): Promise<void> {
  const url = `${CONTROL_PLANE_URL.replace(/\/$/, '')}${path}`;
  const sessionId = (payload as Record<string, unknown>)?.sessionId as string | undefined;
  const eventType = (payload as Record<string, unknown>)?.event && typeof (payload as Record<string, unknown>).event === 'object'
    ? ((payload as Record<string, unknown>).event as Record<string, unknown>)?.type as string | undefined
    : undefined;

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
      log.error('Callback failed', undefined, {
        operation: 'notifyControlPlane',
        reason: `${response.status} ${text}`,
        detail: { path, status: response.status, body: text.slice(0, 500) },
        session_id: sessionId,
        event_type: eventType,
      });
    }
  } catch (error) {
    log.error('Failed to send callback', error, {
      operation: 'notifyControlPlane',
      detail: { path },
      session_id: sessionId,
      event_type: eventType,
    });
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

export async function notifyMessageUpdate(event: MessageUpdateCallback): Promise<void> {
  await notifyControlPlane('/api/internal/message-update', event);
}

export async function notifySSEEvent(event: SSEForwardCallback): Promise<void> {
  await notifyControlPlane('/api/internal/sse-event', event);
}
