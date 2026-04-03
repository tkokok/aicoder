import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

const TEST_DB_PATH = './test-aicoder.db';

let testDb: Database;

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

    CREATE TABLE IF NOT EXISTS session_reports (
      session_id TEXT NOT NULL,
      report_markdown TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
});

afterAll(() => {
  testDb.close();
  require('fs').unlinkSync(TEST_DB_PATH);
});

describe('Database Schema', () => {
  test('sessions table exists with correct columns', () => {
    const tableInfo = testDb.prepare("PRAGMA table_info(sessions)").all();
    const columns = tableInfo.map((col: any) => col.name);
    
    expect(columns).toContain('id');
    expect(columns).toContain('opencode_session_id');
    expect(columns).toContain('status');
    expect(columns).toContain('created_at');
    expect(columns).toContain('completed_at');
  });

  test('session_inputs table exists with correct columns', () => {
    const tableInfo = testDb.prepare("PRAGMA table_info(session_inputs)").all();
    const columns = tableInfo.map((col: any) => col.name);
    
    expect(columns).toContain('session_id');
    expect(columns).toContain('project_name');
    expect(columns).toContain('requirements');
    expect(columns).toContain('tech_stack');
    expect(columns).toContain('dev_env');
    expect(columns).toContain('test_method');
  });

  test('session_reports table exists with correct columns', () => {
    const tableInfo = testDb.prepare("PRAGMA table_info(session_reports)").all();
    const columns = tableInfo.map((col: any) => col.name);
    
    expect(columns).toContain('session_id');
    expect(columns).toContain('report_markdown');
    expect(columns).toContain('created_at');
  });

  test('sessions.id is PRIMARY KEY', () => {
    const tableInfo = testDb.prepare("PRAGMA table_info(sessions)").all();
    const idColumn = tableInfo.find((col: any) => col.name === 'id');
    expect(idColumn.pk).toBe(1);
  });

  test('foreign key constraints are set up', () => {
    const foreignKeys = testDb.prepare("PRAGMA foreign_key_list(session_inputs)").all();
    expect(foreignKeys.length).toBeGreaterThan(0);
    expect(foreignKeys[0].table).toBe('sessions');
  });
});