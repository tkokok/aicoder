import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

const DB_PATH = './aicoder.db';

export const db = new Database(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');

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

function runMigrations() {
  const migrations: Array<[string, string, string]> = [
    ['sessions', 'project_path', 'TEXT'],
    ['sessions', 'opencode_session_id', 'TEXT'],
    ['sessions', 'opencode_url', 'TEXT'],
    ['sessions', 'current_agent', 'TEXT'],
    ['sessions', 'latest_message', 'TEXT'],
    ['sessions', 'stages_json', 'TEXT'],
    ['sessions', 'opencode_header', 'TEXT'],
    ['sessions', 'opencode_username', 'TEXT'],
    ['sessions', 'opencode_password', 'TEXT'],
  ];

  for (const [table, column, type] of migrations) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const existing = rows.map(r => r.name);
    if (!existing.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

runMigrations();

export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function generateId(): string {
  return randomUUID();
}
