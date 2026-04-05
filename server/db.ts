import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { createComponentLogger } from './logger';

const log = createComponentLogger('db');

const DB_PATH = './aicoder.db';

export const db = new Database(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');
log.info('Database initialized', { db_path: DB_PATH });

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

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_url TEXT NOT NULL,
    opencode_local_url TEXT NOT NULL,
    opencode_public_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

function runMigrations() {
  log.info('Running database migrations...', { operation: 'migrate_start' });
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
    ['sessions', 'workspace_path', 'TEXT'],
    ['sessions', 'repo_name', 'TEXT'],
    ['sessions', 'messages_json', 'TEXT'],
    ['session_inputs', 'model', 'TEXT'],
    ['session_inputs', 'subagent_model', 'TEXT'],
    ['sessions', 'agent_id', 'TEXT'],
  ];

  // Run migrations within a transaction for atomicity
  db.transaction(() => {
    for (const [table, column, type] of migrations) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const existing = rows.map(r => r.name);
      if (!existing.includes(column)) {
        log.info(`Running migration: ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, { operation: 'migrate', table, column });
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  })();
}

runMigrations();
log.info('Database migrations completed', { operation: 'migrate_complete' });

export function transaction<T>(fn: () => T): T {
  try {
    const result = db.transaction(fn)();
    return result;
  } catch (error) {
    log.error('Database transaction failed', error, { operation: 'transaction' });
    throw error;
  }
}

export function closeDb(): void {
  log.info('Closing database connection', { operation: 'close' });
  db.close();
}

export function generateId(): string {
  const id = randomUUID();
  log.debug(`Generated new ID: ${id.slice(0, 8)}...`, { operation: 'generate_id' });
  return id;
}
