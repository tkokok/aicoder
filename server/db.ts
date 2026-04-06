import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { createComponentLogger } from './logger';

const log = createComponentLogger('db');

const DB_PATH = process.env.AICODER_DB_PATH || './aicoder.db';

export const db = new Database(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');
log.info('Database initialized', { db_path: DB_PATH });

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data_plane_session_id TEXT,
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
    runtime_config TEXT,
    runtime_link TEXT,
    created_at INTEGER NOT NULL
  );
`);

function runMigrations() {
  log.info('Running database migrations...', { operation: 'migrate_start' });
  const migrations: Array<[string, string, string]> = [
    // sessions 中性化字段
    ['sessions', 'data_plane_session_id', 'TEXT'],
    ['sessions', 'project_path', 'TEXT'],
    ['sessions', 'status', 'TEXT'],
    ['sessions', 'current_agent', 'TEXT'],
    ['sessions', 'latest_message', 'TEXT'],
    ['sessions', 'messages_json', 'TEXT'],
    ['sessions', 'stages_json', 'TEXT'],
    ['sessions', 'workspace_path', 'TEXT'],
    ['sessions', 'repo_name', 'TEXT'],
    ['sessions', 'agent_id', 'TEXT'],
    // session_inputs 字段
    ['session_inputs', 'model', 'TEXT'],
    ['session_inputs', 'subagent_model', 'TEXT'],
    // agents 中性化字段
    ['agents', 'runtime_config', 'TEXT'],
    ['agents', 'runtime_link', 'TEXT'],
    // 遗留字段（兼容已有数据库，仅当不存在时添加）
    ['sessions', 'opencode_session_id', 'TEXT'],
    ['sessions', 'opencode_url', 'TEXT'],
    ['sessions', 'opencode_header', 'TEXT'],
    ['sessions', 'opencode_username', 'TEXT'],
    ['sessions', 'opencode_password', 'TEXT'],
    ['agents', 'opencode_local_url', 'TEXT'],
    ['agents', 'opencode_public_url', 'TEXT'],
  ];

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

  // Rebuild agents table if old NOT NULL columns exist
  const agentsCols = db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string; notnull: number }>;
  const opencodeLocalCol = agentsCols.find(c => c.name === 'opencode_local_url');
  if (opencodeLocalCol && opencodeLocalCol.notnull === 1) {
    log.info('Rebuilding agents table to remove old NOT NULL constraints', { operation: 'rebuild_agents' });
    db.transaction(() => {
      db.exec(`ALTER TABLE agents RENAME TO agents_old`);
      db.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          agent_url TEXT NOT NULL,
          runtime_config TEXT,
          runtime_link TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO agents (id, name, agent_url, runtime_config, runtime_link, created_at)
        SELECT id, name, agent_url, NULL, NULL, created_at FROM agents_old
      `);
      db.exec(`DROP TABLE agents_old`);
    })();
    log.info('Agents table rebuilt', { operation: 'rebuild_agents_done' });
  }
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
