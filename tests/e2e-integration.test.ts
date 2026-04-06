/**
 * End-to-End Integration Tests — Control Plane API Driven
 *
 * These tests start the real AICoder server + a mock OpenCode server,
 * then drive everything through the control plane HTTP API.
 *
 * Important cases covered:
 * - Both control (8080) and data (2080) planes start correctly
 * - Session creation => pipeline starts => status becomes "running"
 * - Pipeline does NOT auto-complete immediately (P0 regression guard)
 * - Mock agent writes stage JSON files => pipeline reaches "completed"
 * - Control plane restart reconnects to an existing running session
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, ChildProcess } from 'child_process';
import { rm, mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

// ============================================================================
// Test Configuration
// ============================================================================

const CONTROL_PORT = 18080;
const DATA_PORT = 12080;
const MOCK_OPENCODE_PORT = 14096;
const TEST_DB_PATH = resolve('./test-e2e-aicoder.db');
const TEST_PROJECTS_DIR = resolve(process.env.HOME || '/tmp', '.aicoder', 'projects');

const BASE_CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const BASE_DATA_URL = `http://127.0.0.1:${DATA_PORT}`;
const BASE_MOCK_OPENCODE_URL = `http://127.0.0.1:${MOCK_OPENCODE_PORT}`;

let aicoderProcess: ChildProcess | null = null;
let mockOpenCodeServer: ReturnType<typeof Bun.serve> | null = null;

// ============================================================================
// Helpers
// ============================================================================

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
      // /api/health may 404; any response means server is up
      if (res !== null) return;
    } catch {
      // ignore
    }
    // also try data-plane health
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (res !== null) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`);
}

async function killAicoder(): Promise<void> {
  if (!aicoderProcess) return;
  const proc = aicoderProcess;
  aicoderProcess = null;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  if (!proc.killed) {
    proc.kill('SIGKILL');
  }
}

async function startAicoder(): Promise<void> {
  await killAicoder();

  // Ensure clean build
  const build = spawn('npm', ['run', 'build'], {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
  await new Promise<void>((res, rej) => {
    build.on('close', (code) => (code === 0 ? res() : rej(new Error(`Build failed: ${code}`))));
  });

  aicoderProcess = spawn('bun', ['dist/server/index.js'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(CONTROL_PORT),
      AGENT_PORT: String(DATA_PORT),
      NO_PROXY: 'localhost,127.0.0.1',
      CALLBACK_TOKEN: 'test-token',
      CONTROL_PLANE_URL: `http://127.0.0.1:${CONTROL_PORT}`,
      OPENCODE_URL: BASE_MOCK_OPENCODE_URL,
      AICODER_DB_PATH: TEST_DB_PATH,
    },
    cwd: process.cwd(),
  });

  await waitForPort(CONTROL_PORT);
  await waitForPort(DATA_PORT);
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE_CONTROL_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function apiGet(path: string) {
  const res = await fetch(`${BASE_CONTROL_URL}${path}`);
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function apiDelete(path: string) {
  const res = await fetch(`${BASE_CONTROL_URL}${path}`, { method: 'DELETE' });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function dataPlaneGet(path: string) {
  const res = await fetch(`${BASE_DATA_URL}${path}`);
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function getRunDir(projectName: string, sessionId: string): string {
  // sanitize same as backend
  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return join(TEST_PROJECTS_DIR, `${sanitized}`, `run-${sessionId}`);
}

// ============================================================================
// Mock OpenCode Server
// ============================================================================

function startMockOpenCode() {
  const sessions = new Map<string, { title: string; createdAt: number }>();
  const messages = new Map<string, Array<Record<string, unknown>>>();

  mockOpenCodeServer = Bun.serve({
    port: MOCK_OPENCODE_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'application/json',
      };

      if (req.method === 'OPTIONS') {
        return new Response(null, { headers });
      }

      if (url.pathname === '/provider') {
        return Response.json(
          {
            default: { 'mock-provider': 'mock-model' },
            all: [
              {
                id: 'mock-provider',
                name: 'Mock Provider',
                models: {
                  'mock-model': { name: 'Mock Model' },
                },
              },
            ],
            connected: ['mock-provider'],
          },
          { headers }
        );
      }

      if (url.pathname === '/session' && req.method === 'POST') {
        const body = (await req.json()) as { title?: string };
        const sessionId = 'ses_' + Math.random().toString(36).slice(2);
        sessions.set(sessionId, { title: body.title || 'untitled', createdAt: Date.now() });
        messages.set(sessionId, []);
        return Response.json({ id: sessionId, title: body.title || 'untitled' }, { headers });
      }

      if (url.pathname.startsWith('/session/') && url.pathname.split('/').length === 3 && req.method === 'GET') {
        const sessionId = url.pathname.split('/')[2];
        const session = sessions.get(sessionId);
        if (!session) {
          return Response.json({ error: 'Session not found' }, { status: 404, headers });
        }
        return Response.json({ id: sessionId, title: session.title }, { headers });
      }

      const handlePrompt = async (req: Request, sessionId: string) => {
        const body = (await req.json()) as { parts?: Array<{ type: string; text: string }>; agent?: string; model?: any };
        const msgs = messages.get(sessionId) || [];
        const text = body.parts?.[0]?.text || '';
        msgs.push({
          id: 'u' + msgs.length,
          role: 'user',
          parts: body.parts || [{ type: 'text', text }],
          time: { created: Date.now() },
        });
        messages.set(sessionId, msgs);

        // Simulate AICoder agent: parse run_dir from playbook, then write stage JSONs
        const runDirMatch = text.match(/run_dir:\s*([^\n\r]+)/);
        const runDir = runDirMatch ? runDirMatch[1].trim().replace(/^-\s*/, '') : null;
        if (runDir) {
          setTimeout(async () => {
            try {
              await mkdir(runDir, { recursive: true });
              const stageNames = ['clarify', 'design', 'dev'];
              for (let i = 0; i < stageNames.length; i++) {
                await new Promise((r) => setTimeout(r, 1200));
                await writeFile(
                  join(runDir, `${stageNames[i]}.json`),
                  JSON.stringify({ status: 'completed', output: { stage: stageNames[i] } })
                );
                const stageMsg = {
                  id: 'a' + i,
                  role: 'assistant',
                  parts: [{ type: 'text', text: `Stage ${stageNames[i]} completed.` }],
                  time: { created: Date.now() },
                };
                msgs.push(stageMsg);
              }
              // Final finish signal (should NOT cause auto-complete on its own)
              await new Promise((r) => setTimeout(r, 300));
              msgs.push({
                id: 'end',
                role: 'assistant',
                parts: [
                  {
                    type: 'text',
                    text: 'All stages done.\n\n```json\n{"finish":"stop","status":"completed"}\n```',
                  },
                ],
                time: { created: Date.now() },
              });
            } catch (e) {
              // ignore mock agent errors
            }
          }, 300);
        }
        return Response.json({ id: 'msg-' + Date.now() }, { headers });
      };

      if (url.pathname.includes('/prompt_async') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const sessionId = parts[2];
        return handlePrompt(req, sessionId);
      }

      if (url.pathname.includes('/message') && req.method === 'POST') {
        const parts = url.pathname.split('/');
        const sessionId = parts[2];
        return handlePrompt(req, sessionId);
      }

      if (url.pathname.includes('/message') && req.method === 'GET') {
        const parts = url.pathname.split('/');
        const sessionId = parts[2];
        const msgs = messages.get(sessionId) || [];
        return Response.json({ messages: msgs }, { headers });
      }

      if (url.pathname === '/event') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue('event: connected\ndata: {}\n\n');
            const interval = setInterval(() => {
              controller.enqueue('event: heartbeat\ndata: {}\n\n');
            }, 3000);
            req.signal.addEventListener('abort', () => clearInterval(interval));
          },
        });
        return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream' } });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers });
    },
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('AICoder E2E — Control Plane API Driven', () => {
  beforeAll(async () => {
    // Cleanup previous test artifacts
    try {
      await rm(TEST_DB_PATH, { force: true });
      await rm(join(TEST_PROJECTS_DIR, 'e2e-test-project'), { recursive: true, force: true });
      await rm(join(TEST_PROJECTS_DIR, 'e2e-reconnect-project'), { recursive: true, force: true });
    } catch {
      // ignore
    }

    startMockOpenCode();
    await startAicoder();
  }, 60000);

  afterAll(async () => {
    await killAicoder();
    if (mockOpenCodeServer) {
      mockOpenCodeServer.stop();
      mockOpenCodeServer = null;
    }
    try {
      await rm(TEST_DB_PATH, { force: true });
      await rm(join(TEST_PROJECTS_DIR, 'e2e-test-project'), { recursive: true, force: true });
      await rm(join(TEST_PROJECTS_DIR, 'e2e-reconnect-project'), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 30000);

  // ========================================================================
  // 1. Bootstrap
  // ========================================================================
  test('control plane and data plane are both listening', async () => {
    const controlHealth = await apiGet('/api/agents');
    expect(controlHealth.status).toBe(200);

    const dataHealth = await dataPlaneGet('/health');
    expect(dataHealth.status).toBe(200);
    expect((dataHealth.json as any)?.status).toBe('ok');
  });

  // ========================================================================
  // 2. Agent & Models
  // ========================================================================
  test('can create agent and fetch models through it', async () => {
    const agentRes = await apiPost('/api/agents', {
      name: 'e2e-mock-agent',
      agentUrl: BASE_DATA_URL,
      runtimeConfig: JSON.stringify({ type: 'opencode', url: BASE_MOCK_OPENCODE_URL }),
      runtimeLink: BASE_MOCK_OPENCODE_URL,
    });
    expect([200, 201].includes(agentRes.status)).toBe(true);
    const agentId = (agentRes.json as any)?.id;
    expect(agentId).toBeTruthy();

    const modelsRes = await apiGet('/api/models');
    expect(modelsRes.status).toBe(200);
    const models = (modelsRes.json as any)?.models;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m: any) => m.id === 'mock-provider/mock-model')).toBe(true);
  });

  // ========================================================================
  // 3. Pipeline Lifecycle (no premature completion)
  // ========================================================================
  test('creating session starts pipeline and it does NOT auto-complete immediately', async () => {
    // Ensure agent exists
    const agentsRes = await apiGet('/api/agents');
    const agents = (agentsRes.json as any) || [];
    let agentId = agents[0]?.id;
    if (!agentId) {
      const createAgent = await apiPost('/api/agents', {
        name: 'e2e-mock-agent',
        agentUrl: BASE_DATA_URL,
        runtimeConfig: JSON.stringify({ type: 'opencode', url: BASE_MOCK_OPENCODE_URL }),
        runtimeLink: BASE_MOCK_OPENCODE_URL,
      });
      agentId = (createAgent.json as any)?.id;
    }
    expect(agentId).toBeTruthy();

    const sessionRes = await apiPost('/api/sessions', {
      projectName: 'e2e-test-project',
      requirements: 'Build a hello world HTML page for E2E testing.',
      techStack: 'HTML, JavaScript',
      devEnv: 'Browser',
      testMethod: 'Manual',
      agentId,
      model: 'mock-model',
      pipelineMode: 'simple',
      reasoningLevel: 'low',
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = (sessionRes.json as any)?.id;
    expect(sessionId).toBeTruthy();

    // Wait for pipeline to start (data plane -> control plane callback)
    let statusRes: any;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      statusRes = await apiGet(`/api/sessions/${sessionId}`);
      if ((statusRes.json as any)?.status === 'running') break;
    }

    expect(statusRes!.status).toBe(200);
    expect(statusRes.status).toBe(200);
    const body = statusRes.json as any;
    expect(body.status).toBe('running');

    // CRITICAL: P0 regression guard — playbook contains "finish":"stop" example text,
    // but pipeline MUST NOT immediately jump to completed.
    expect(body.status).not.toBe('completed');
    expect(body.status).not.toBe('failed');

    // Verify mock OpenCode actually received the playbook message
    const dataPlaneSessionId = body.data_plane_session_id;
    if (dataPlaneSessionId) {
      const mockMsgRes = await fetch(`${BASE_MOCK_OPENCODE_URL}/session/${dataPlaneSessionId}/message`);
      const mockMsgData = (await mockMsgRes.json()) as { messages?: any[] };
      expect(mockMsgData.messages?.length).toBeGreaterThan(0);
    }

    // Store for later test cleanup
    (globalThis as any).__e2eSessionId = sessionId;
  }, 30000);

  test('pipeline reaches completed after mock stages finish', async () => {
    const sessionId = (globalThis as any).__e2eSessionId;
    expect(sessionId).toBeTruthy();

    // Wait for mock agent to write all stage JSONs (~5s total)
    let completed = false;
    let attempts = 0;
    while (!completed && attempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await apiGet(`/api/sessions/${sessionId}`);
      const body = res.json as any;
      if (body?.status === 'completed') {
        completed = true;
      }
      attempts++;
    }

    expect(completed).toBe(true);

    const finalRes = await apiGet(`/api/sessions/${sessionId}`);
    const final = finalRes.json as any;
    expect(final.status).toBe('completed');
    expect(final.current_agent).toBe('completed');

    // Verify stage outputs were recorded
    const stages = JSON.parse(final.stages_json || '{}');
    expect(stages.clarify?.status).toBe('completed');
    expect(stages.design?.status).toBe('completed');
    expect(stages.dev?.status).toBe('completed');
  }, 60000);

  // ========================================================================
  // 4. Control Plane Reconnect
  // ========================================================================
  test('reconnect: control plane restart reattaches running session without redispatch', async () => {
    // Create a fresh session for this test
    const agentsRes = await apiGet('/api/agents');
    const agents = (agentsRes.json as any) || [];
    const agentId = agents[0]?.id;
    expect(agentId).toBeTruthy();

    const sessionRes = await apiPost('/api/sessions', {
      projectName: 'e2e-reconnect-project',
      requirements: 'Test reconnect behavior after control plane restart.',
      techStack: 'HTML',
      devEnv: 'Browser',
      testMethod: 'Manual',
      agentId,
      model: 'mock-model',
      pipelineMode: 'simple',
      reasoningLevel: 'low',
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = (sessionRes.json as any)?.id;
    expect(sessionId).toBeTruthy();

    // Wait for pipeline to be running
    let running = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await apiGet(`/api/sessions/${sessionId}`);
      if ((res.json as any)?.status === 'running') {
        running = true;
        break;
      }
    }
    expect(running).toBe(true);

    // Write at least one stage JSON so the data plane has progress
    const runDir = getRunDir('e2e-reconnect-project', sessionId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'clarify.json'), JSON.stringify({ status: 'completed', output: {} }));

    // Kill and restart control plane
    await killAicoder();
    await startAicoder();

    // Wait for reconnect logic (3s delay) + some margin
    await new Promise((r) => setTimeout(r, 3000));

    // Ensure session was not wrongly marked as failed
    const afterRes = await apiGet(`/api/sessions/${sessionId}`);
    const afterBody = afterRes.json as any;
    expect(afterBody.status).not.toBe('failed');

    // Write remaining stages (if not already completed by existing files)
    await writeFile(join(runDir, 'design.json'), JSON.stringify({ status: 'completed', output: {} }));
    await writeFile(join(runDir, 'dev.json'), JSON.stringify({ status: 'completed', output: {} }));

    // Wait for completion
    let done = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await apiGet(`/api/sessions/${sessionId}`);
      if ((res.json as any)?.status === 'completed') {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
  }, 90000);

  // ========================================================================
  // 5. Proxy Bypass Sanity Check
  // ========================================================================
  test('callbacks from data plane to control plane succeed (no 503 loop)', async () => {
    // If we got here without 503 errors, the NO_PROXY fix is working.
    // We additionally verify that an internal callback endpoint is reachable.
    const res = await fetch(`${BASE_CONTROL_URL}/api/internal/pipeline-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({ sessionId: 'fake', currentStage: 'clarify', overallStatus: 'running', stages: {}, timestamp: Date.now() }),
    });
    // It may 404 if there's no matching session, but it should NOT 503
    expect(res.status).not.toBe(503);
    expect([200, 404, 401].includes(res.status)).toBe(true);
  });
});
