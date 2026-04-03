import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

const TEST_DB_PATH = './test-transaction.db';

let testDb: Database;

function transaction<T>(fn: () => T): T {
  return testDb.transaction(fn)();
}

beforeAll(() => {
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
  `);
});

afterAll(() => {
  testDb.close();
  require('fs').unlinkSync(TEST_DB_PATH);
});

describe('Transaction Wrapper', () => {
  test('transaction commits on success', () => {
    const sessionId = randomUUID();
    const now = Date.now();

    transaction(() => {
      testDb.prepare(`
        INSERT INTO sessions (id, status, created_at)
        VALUES (?, ?, ?)
      `).run(sessionId, 'active', now);

      testDb.prepare(`
        INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, 'test-project', 'requirements text', 'typescript', 'node', 'bun test');
    });

    const session = testDb.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const input = testDb.prepare('SELECT * FROM session_inputs WHERE session_id = ?').get(sessionId);

    expect(session).toBeDefined();
    expect(input).toBeDefined();
    expect((session as any).status).toBe('active');
  });

  test('transaction rolls back on error', () => {
    const sessionId = randomUUID();
    const now = Date.now();

    try {
      transaction(() => {
        testDb.prepare(`
          INSERT INTO sessions (id, status, created_at)
          VALUES (?, ?, ?)
        `).run(sessionId, 'active', now);

        testDb.prepare(`
          INSERT INTO session_inputs (session_id, project_name, requirements, tech_stack, dev_env, test_method)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionId, 'test-project', 'requirements text', 'typescript', 'node', 'bun test');

        throw new Error('Simulated error');
      });
    } catch (e) {
    }

    const session = testDb.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const input = testDb.prepare('SELECT * FROM session_inputs WHERE session_id = ?').get(sessionId);

    expect(session).toBeNull();
    expect(input).toBeNull();
  });

  test('transaction returns value correctly', () => {
    const result = transaction(() => {
      return 42;
    });
    expect(result).toBe(42);
  });
});