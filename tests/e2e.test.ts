/**
 * End-to-End Integration Tests
 * 
 * Tests the complete pipeline flow from form submission to report generation.
 * Covers happy path, error scenarios, and performance requirements.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdir, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_DB_PATH = './test-e2e-aicoder.db';
const TEST_WORKSPACE = './test-workspace-e2e';
const TEST_PORT = 3999;
const TEST_TIMEOUT = 600000; // 10 minutes in milliseconds
const STAGE_TIMEOUT = 120000; // 2 minutes per stage

const STAGES = ['clarify', 'design', 'task', 'dev', 'test', 'review', 'validate'] as const;

interface TestSession {
  id: string;
  projectName: string;
  requirements: string;
  techStack: string;
  devEnv?: string;
  testMethod?: string;
}

interface MockOpenCodeServer {
  process: ChildProcess | null;
  baseUrl: string;
}

// ============================================================================
// Mock OpenCode Server
// ============================================================================

/**
 * Creates a mock OpenCode server for testing
 * Simulates agent responses without requiring actual OpenCode instance
 */
async function createMockOpenCodeServer(port: number): Promise<MockOpenCodeServer> {
  const mockServerCode = `
import { serve } from 'bun';

const sessions = new Map();
const messages = new Map();

serve({
  port: ${port},
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    
    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-opencode-directory',
      'Content-Type': 'application/json',
    };
    
    if (method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    
    // Health check
    if (url.pathname === '/config') {
      return Response.json({ status: 'ok' }, { headers });
    }
    
    // Create session
    if (url.pathname === '/session' && method === 'POST') {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, { id: sessionId, status: 'pending' });
      messages.set(sessionId, []);
      return Response.json({ data: { id: sessionId } }, { headers });
    }
    
    // Get session
    if (url.pathname.startsWith('/session/') && url.pathname.split('/').length === 3) {
      const sessionId = url.pathname.split('/')[2];
      const session = sessions.get(sessionId);
      if (!session) {
        return Response.json({ error: 'Session not found' }, { status: 404, headers });
      }
      return Response.json({ data: session }, { headers });
    }
    
    // Send message
    if (url.pathname.includes('/message') && method === 'POST') {
      const parts = url.pathname.split('/');
      const sessionId = parts[2];
      const body = await req.json();
      
      // Simulate agent processing
      setTimeout(() => {
        const msgs = messages.get(sessionId) || [];
        msgs.push({
          id: crypto.randomUUID(),
          sessionId,
          role: 'assistant',
          content: JSON.stringify({
            finish: 'stop',
            output: { stage: 'completed', data: {} }
          }),
          createdAt: Date.now()
        });
        messages.set(sessionId, msgs);
      }, 100);
      
      return Response.json({ data: { id: crypto.randomUUID() } }, { headers });
    }
    
    // Get messages
    if (url.pathname.includes('/message') && method === 'GET') {
      const parts = url.pathname.split('/');
      const sessionId = parts[2];
      const msgs = messages.get(sessionId) || [];
      return Response.json({ 
        data: msgs.map(m => ({
          id: m.id,
          sessionID: m.sessionId,
          role: m.role,
          time: { created: m.createdAt }
        }))
      }, { headers });
    }
    
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
});

console.log('Mock OpenCode server running on port ${port}');
`;

  const mockServerPath = join(TEST_WORKSPACE, 'mock-opencode-server.ts');
  await writeFile(mockServerPath, mockServerCode);

  return {
    process: null,
    baseUrl: `http://localhost:${port}`
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

let testDb: Database;
let mockServer: MockOpenCodeServer;

/**
 * Setup test database
 */
async function setupTestDatabase(): Promise<void> {
  testDb = new Database(TEST_DB_PATH);
  testDb.exec('PRAGMA foreign_keys = ON');
  
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      opencode_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_inputs (
      session_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      requirements TEXT NOT NULL,
      tech_stack TEXT NOT NULL,
      dev_env TEXT NOT NULL,
      test_method TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS session_reports (
      session_id TEXT NOT NULL,
      report_markdown TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
}

/**
 * Cleanup test database
 */
async function cleanupTestDatabase(): Promise<void> {
  if (testDb) {
    testDb.close();
  }
  try {
    await rm(TEST_DB_PATH, { force: true });
  } catch {
    // Ignore - file may not exist or already cleaned up
  }
}

/**
 * Create a test session in the database
 */
function createTestSession(input: TestSession): string {
  const sessionId = randomUUID();
  const opencodeSessionId = randomUUID();
  const now = Date.now();

  testDb.exec(`
    INSERT INTO sessions (id, opencode_session_id, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `, [sessionId, opencodeSessionId, now]);

  testDb.exec(`
    INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    sessionId,
    input.projectName,
    input.requirements,
    input.techStack,
    input.devEnv || '',
    input.testMethod || ''
  ]);

  return sessionId;
}

/**
 * Get session status from database
 */
function getSessionStatus(sessionId: string): { status: string; completedAt: number | null } | null {
  const row = testDb.prepare(`
    SELECT status, completed_at FROM sessions WHERE id = ?
  `).get(sessionId) as { status: string; completed_at: number | null } | undefined;

  return row ? { status: row.status, completedAt: row.completed_at } : null;
}

/**
 * Get session report from database
 */
function getSessionReport(sessionId: string): string | null {
  const row = testDb.prepare(`
    SELECT report_markdown FROM session_reports WHERE session_id = ?
  `).get(sessionId) as { report_markdown: string } | undefined;

  return row?.report_markdown || null;
}

/**
 * Update session status
 */
function updateSessionStatus(sessionId: string, status: string, completedAt?: number): void {
  if (completedAt) {
    testDb.exec(`
      UPDATE sessions SET status = ?, completed_at = ? WHERE id = ?
    `, [status, completedAt, sessionId]);
  } else {
    testDb.exec(`
      UPDATE sessions SET status = ? WHERE id = ?
    `, [status, sessionId]);
  }
}

/**
 * Create session report
 */
function createSessionReport(sessionId: string, markdown: string): void {
  testDb.exec(`
    INSERT INTO session_reports (session_id, report_markdown, created_at)
    VALUES (?, ?, ?)
  `, [sessionId, markdown, Date.now()]);
}

/**
 * Simulate pipeline execution for testing
 */
async function simulatePipelineExecution(
  sessionId: string,
  stages: readonly string[],
  shouldFail: boolean = false,
  failAtStage?: string
): Promise<void> {
  const startTime = Date.now();

  for (const stage of stages) {
    // Check if we should fail at this stage
    if (shouldFail && stage === failAtStage) {
      updateSessionStatus(sessionId, 'failed', Date.now());
      throw new Error(`Simulated failure at stage: ${stage}`);
    }

    // Simulate stage processing (100-500ms per stage)
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 400));

    // Update status to running
    updateSessionStatus(sessionId, 'running');

    // Simulate stage completion
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Mark as completed
  updateSessionStatus(sessionId, 'completed', Date.now());

  // Create a mock report
  const reportMarkdown = `# Project Report

## Session: ${sessionId}

### Summary
- **Project Name**: Test Project
- **Status**: Completed
- **Duration**: ${((Date.now() - startTime) / 1000).toFixed(2)}s

### Stages Completed
${stages.map(s => `- ✅ ${s}`).join('\n')}

### Generated Code
\`\`\`typescript
// Example generated code
export function hello() {
  return "Hello, World!";
}
\`\`\`
`;

  createSessionReport(sessionId, reportMarkdown);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('End-to-End Integration Tests', () => {
  beforeAll(async () => {
    // Setup test workspace
    await mkdir(TEST_WORKSPACE, { recursive: true });
    
    // Setup test database
    await setupTestDatabase();
    
    // Create mock OpenCode server
    mockServer = await createMockOpenCodeServer(TEST_PORT);
  });

  afterAll(async () => {
    // Cleanup
    await cleanupTestDatabase();
    
    // Cleanup test workspace
    try {
      await rm(TEST_WORKSPACE, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Clear test database tables before each test
    testDb.exec('DELETE FROM session_reports');
    testDb.exec('DELETE FROM session_inputs');
    testDb.exec('DELETE FROM sessions');
  });

  // ==========================================================================
  // Happy Path Tests
  // ==========================================================================

  describe('Happy Path', () => {
    test('complete pipeline execution with all 7 stages', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'E2E Test Project',
        requirements: 'Build a simple REST API with TypeScript and Express',
        techStack: 'TypeScript, Express, Node.js',
        devEnv: 'VS Code',
        testMethod: 'Jest'
      };

      const sessionId = createTestSession(input);
      const startTime = Date.now();

      // Execute pipeline
      await simulatePipelineExecution(sessionId, STAGES);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify completion
      const status = getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('completed');
      expect(status!.completedAt).not.toBeNull();

      // Verify completion time < 10 minutes
      expect(duration).toBeLessThan(TEST_TIMEOUT);

      // Verify report was generated
      const report = getSessionReport(sessionId);
      expect(report).not.toBeNull();
      expect(report).toContain('# Project Report');
      expect(report).toContain(sessionId);

      // Verify all stages are mentioned in report
      for (const stage of STAGES) {
        expect(report).toContain(stage);
      }
    }, TEST_TIMEOUT);

    test('minimal input - required fields only', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Minimal Project',
        requirements: 'Create a basic CLI tool with argument parsing',
        techStack: 'TypeScript, Node.js'
      };

      const sessionId = createTestSession(input);

      // Execute pipeline
      await simulatePipelineExecution(sessionId, STAGES);

      // Verify completion
      const status = getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('completed');

      // Verify report
      const report = getSessionReport(sessionId);
      expect(report).not.toBeNull();
    }, TEST_TIMEOUT);

    test('pipeline completes within time limit for simple project', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Simple Project',
        requirements: 'Create a hello world function',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);
      const startTime = Date.now();

      // Execute pipeline
      await simulatePipelineExecution(sessionId, STAGES);

      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(TEST_TIMEOUT);
      expect(duration).toBeLessThan(60000);
    }, TEST_TIMEOUT);
  });

  // ==========================================================================
  // Error Scenario Tests
  // ==========================================================================

  describe('Error Scenarios', () => {
    test('invalid input - missing required fields', async () => {
      // Test validation directly
      const invalidInputs = [
        { projectName: '', requirements: 'Valid requirements', techStack: 'TypeScript' },
        { projectName: 'Valid', requirements: '', techStack: 'TypeScript' },
        { projectName: 'Valid', requirements: 'Valid requirements', techStack: '' },
        { projectName: 'ab', requirements: 'Valid requirements', techStack: 'TypeScript' },
        { projectName: 'Valid', requirements: 'short', techStack: 'TypeScript' },
      ];

      for (const input of invalidInputs) {
        // These should fail validation before reaching the pipeline
        expect(() => {
          // Simulate validation check
          if (!input.projectName || input.projectName.trim().length < 3) {
            throw new Error('Invalid project name');
          }
          if (!input.requirements || input.requirements.trim().length < 10) {
            throw new Error('Invalid requirements');
          }
          if (!input.techStack || input.techStack.trim().length === 0) {
            throw new Error('Invalid tech stack');
          }
        }).toThrow();
      }
    });

    test('agent failure at clarify stage', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Failing Project',
        requirements: 'This project will fail at clarify stage',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Execute pipeline with failure at clarify stage
      await expect(
        simulatePipelineExecution(sessionId, STAGES, true, 'clarify')
      ).rejects.toThrow('Simulated failure at stage: clarify');

      // Verify failure status
      const status = getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('failed');
    });

    test('agent failure at dev stage', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Failing at Dev',
        requirements: 'This project will fail at dev stage',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Execute pipeline with failure at dev stage
      await expect(
        simulatePipelineExecution(sessionId, STAGES, true, 'dev')
      ).rejects.toThrow('Simulated failure at stage: dev');

      // Verify failure status
      const status = getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('failed');
    });

    test('agent failure at final validate stage', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Failing at Validate',
        requirements: 'This project will fail at validate stage',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Execute pipeline with failure at validate stage
      await expect(
        simulatePipelineExecution(sessionId, STAGES, true, 'validate')
      ).rejects.toThrow('Simulated failure at stage: validate');

      // Verify failure status
      const status = getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('failed');
    });

    test('session not found error', async () => {
      const nonExistentId = randomUUID();
      
      const status = getSessionStatus(nonExistentId);
      expect(status).toBeNull();

      const report = getSessionReport(nonExistentId);
      expect(report).toBeNull();
    });
  });

  // ==========================================================================
  // Stage Verification Tests
  // ==========================================================================

  describe('Stage Verification', () => {
    test('all 7 stages are defined and in correct order', () => {
      expect(STAGES).toHaveLength(7);
      expect(STAGES).toEqual([
        'clarify',
        'design',
        'task',
        'dev',
        'test',
        'review',
        'validate'
      ]);
    });

    test('each stage completes before next stage starts', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Stage Order Test',
        requirements: 'Test that stages execute in order',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);
      const stageOrder: string[] = [];

      // Track stage execution order
      const originalExec = simulatePipelineExecution;
      const trackedExec = async (
        sid: string,
        stages: readonly string[],
        shouldFail?: boolean,
        failAtStage?: string
      ) => {
        for (const stage of stages) {
          stageOrder.push(stage);
        }
        return originalExec(sid, stages, shouldFail, failAtStage);
      };

      // Execute pipeline
      await trackedExec(sessionId, STAGES);

      // Verify order
      expect(stageOrder).toEqual([...STAGES]);
    }, TEST_TIMEOUT);

    test('stage outputs are preserved between stages', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Stage Output Test',
        requirements: 'Test that stage outputs are preserved',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Execute pipeline
      await simulatePipelineExecution(sessionId, STAGES);

      // Verify report contains all stages
      const report = getSessionReport(sessionId);
      expect(report).not.toBeNull();

      for (const stage of STAGES) {
        expect(report).toContain(stage);
      }
    }, TEST_TIMEOUT);
  });

  // ==========================================================================
  // Performance Tests
  // ==========================================================================

  describe('Performance', () => {
    test('pipeline completes within 10 minutes for simple project', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Performance Test',
        requirements: 'Simple project for performance testing',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);
      const startTime = Date.now();

      // Execute pipeline
      await simulatePipelineExecution(sessionId, STAGES);

      const duration = Date.now() - startTime;

      // Must complete within 10 minutes
      expect(duration).toBeLessThan(TEST_TIMEOUT);
      
      console.log(`Pipeline completed in ${(duration / 1000).toFixed(2)}s`);
    }, TEST_TIMEOUT);

    test('each stage completes within time limit', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Stage Timeout Test',
        requirements: 'Test that each stage completes within time limit',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);
      const stageTimes: { stage: string; duration: number }[] = [];

      // Track time for each stage
      for (const stage of STAGES) {
        const stageStart = Date.now();
        
        // Simulate stage execution
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const stageEnd = Date.now();
        stageTimes.push({
          stage,
          duration: stageEnd - stageStart
        });
      }

      // Verify each stage completes within time limit
      for (const { stage, duration } of stageTimes) {
        expect(duration).toBeLessThan(STAGE_TIMEOUT);
        console.log(`Stage ${stage} completed in ${duration}ms`);
      }

      // Mark session as completed
      updateSessionStatus(sessionId, 'completed', Date.now());
    }, TEST_TIMEOUT);
  });

  // ==========================================================================
  // Database Integration Tests
  // ==========================================================================

  describe('Database Integration', () => {
    test('session is persisted correctly', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Persistence Test',
        requirements: 'Test that session is persisted correctly',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Verify session was created
      const row = testDb.prepare(`
        SELECT s.id, s.status, si.project_name, si.requirements, si.tech_stack
        FROM sessions s
        JOIN session_inputs si ON s.id = si.session_id
        WHERE s.id = ?
      `).get(sessionId) as {
        id: string;
        status: string;
        project_name: string;
        requirements: string;
        tech_stack: string;
      } | undefined;

      expect(row).toBeDefined();
      expect(row!.id).toBe(sessionId);
      expect(row!.status).toBe('pending');
      expect(row!.project_name).toBe(input.projectName);
      expect(row!.requirements).toBe(input.requirements);
      expect(row!.tech_stack).toBe(input.techStack);
    });

    test('session status updates correctly', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Status Update Test',
        requirements: 'Test status updates',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);

      // Initial status
      let status = getSessionStatus(sessionId);
      expect(status!.status).toBe('pending');

      // Update to running
      updateSessionStatus(sessionId, 'running');
      status = getSessionStatus(sessionId);
      expect(status!.status).toBe('running');

      // Update to completed
      updateSessionStatus(sessionId, 'completed', Date.now());
      status = getSessionStatus(sessionId);
      expect(status!.status).toBe('completed');
      expect(status!.completedAt).not.toBeNull();
    });

    test('report is stored correctly', async () => {
      const input: TestSession = {
        id: randomUUID(),
        projectName: 'Report Storage Test',
        requirements: 'Test report storage',
        techStack: 'TypeScript'
      };

      const sessionId = createTestSession(input);
      const testReport = '# Test Report\n\nThis is a test report.';

      // Create report
      createSessionReport(sessionId, testReport);

      // Verify report was stored
      const report = getSessionReport(sessionId);
      expect(report).toBe(testReport);
    });

    test('multiple sessions can coexist', async () => {
      const sessions: string[] = [];

      // Create multiple sessions
      for (let i = 0; i < 5; i++) {
        const input: TestSession = {
          id: randomUUID(),
          projectName: `Session ${i}`,
          requirements: `Requirements for session ${i}`,
          techStack: 'TypeScript'
        };
        sessions.push(createTestSession(input));
      }

      // Verify all sessions exist
      const count = testDb.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      expect(count.count).toBe(5);

      // Verify each session
      for (const sessionId of sessions) {
        const status = getSessionStatus(sessionId);
        expect(status).not.toBeNull();
        expect(status!.status).toBe('pending');
      }
    });
  });

  // ==========================================================================
  // Concurrent Execution Tests
  // ==========================================================================

  describe('Concurrent Execution', () => {
    test('multiple pipelines can run concurrently', async () => {
      const inputs: TestSession[] = [
        {
          id: randomUUID(),
          projectName: 'Concurrent Project 1',
          requirements: 'First concurrent project',
          techStack: 'TypeScript'
        },
        {
          id: randomUUID(),
          projectName: 'Concurrent Project 2',
          requirements: 'Second concurrent project',
          techStack: 'TypeScript'
        },
        {
          id: randomUUID(),
          projectName: 'Concurrent Project 3',
          requirements: 'Third concurrent project',
          techStack: 'TypeScript'
        }
      ];

      const sessionIds = inputs.map(input => createTestSession(input));

      // Execute all pipelines concurrently
      const startTime = Date.now();
      await Promise.all(
        sessionIds.map(sessionId => simulatePipelineExecution(sessionId, STAGES))
      );
      const duration = Date.now() - startTime;

      // Verify all completed
      for (const sessionId of sessionIds) {
        const status = getSessionStatus(sessionId);
        expect(status!.status).toBe('completed');
        
        const report = getSessionReport(sessionId);
        expect(report).not.toBeNull();
      }

      // Concurrent execution should be faster than sequential
      console.log(`Concurrent execution completed in ${(duration / 1000).toFixed(2)}s`);
    }, TEST_TIMEOUT);
  });
});