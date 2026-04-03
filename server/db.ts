import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

const DB_PATH = './aicoder.db';

export const db = new Database(DB_PATH);

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    opencode_session_id TEXT,
    project_path TEXT,
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

// Transaction wrapper for all write operations
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

// Helper to generate UUID
export function generateId(): string {
  return randomUUID();
}