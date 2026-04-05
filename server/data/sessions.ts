import type { OpenCodeClient } from './opencode.js';

interface DataPlaneSession {
  sessionId: string;
  opencodeSessionId: string;
  client: OpenCodeClient;
  projectDir: string;
  stopPipeline: () => void;
}

const sessions = new Map<string, DataPlaneSession>();

export function registerSession(session: DataPlaneSession): void {
  sessions.set(session.sessionId, session);
}

export function getSession(sessionId: string): DataPlaneSession | undefined {
  return sessions.get(sessionId);
}

export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
}
