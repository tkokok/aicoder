/**
 * Unified Logging System for AICoder
 *
 * Features:
 * - Structured logging with context (session_id, stage, operation)
 * - Multiple log levels: info, warn, error
 * - File output with daily rotation
 * - Console output with color coding
 * - Automatic context propagation
 */

import { mkdir, appendFile, stat, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Log Configuration
// ============================================================================

const LOG_DIR = join(process.cwd(), 'logs');
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB per file

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  session_id?: string;
  stage?: string;
  operation?: string;
  component?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

// ============================================================================
// Color Helpers (Console Only)
// ============================================================================

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: COLORS.dim,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
};

const LEVEL_ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
};

// ============================================================================
// Log File Management
// ============================================================================

let logInitialized = false;

async function ensureLogDir(): Promise<void> {
  if (!logInitialized) {
    await mkdir(LOG_DIR, { recursive: true });
    logInitialized = true;
  }
}

function getLogFilePath(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  return join(LOG_DIR, `aicoder-${date}.log`);
}

async function rotateIfNeeded(): Promise<void> {
  const logPath = getLogFilePath();
  try {
    const stats = await stat(logPath);
    if (stats.size > LOG_MAX_BYTES) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = join(LOG_DIR, `aicoder-${timestamp}.log`);
      await rename(logPath, rotatedPath);
    }
  } catch {
    // File doesn't exist yet, no rotation needed
  }
}

async function writeToFile(entry: LogEntry): Promise<void> {
  try {
    await ensureLogDir();
    await rotateIfNeeded();
    const logPath = getLogFilePath();
    const line = JSON.stringify(entry) + '\n';
    await appendFile(logPath, line, 'utf-8');
  } catch (error) {
    // Fallback: console only if file write fails
    console.error('[logger] Failed to write log file:', error);
  }
}

// ============================================================================
// Logger Class
// ============================================================================

class Logger {
  private defaultContext: LogContext = {};

  /**
   * Set default context that will be included in all log entries
   */
  setContext(context: LogContext): void {
    this.defaultContext = { ...this.defaultContext, ...context };
  }

  /**
   * Clear a specific context key or all context
   */
  clearContext(key?: string): void {
    if (key) {
      delete this.defaultContext[key];
    } else {
      this.defaultContext = {};
    }
  }

  /**
   * Create a child logger with fixed context
   */
  child(context: LogContext): Logger {
    const childLogger = new Logger();
    childLogger.defaultContext = { ...this.defaultContext, ...context };
    return childLogger;
  }

  /**
   * Format context for console display
   */
  private formatContextConsole(context?: LogContext): string {
    const merged = { ...this.defaultContext, ...context };
    const parts: string[] = [];

    if (merged.session_id) {
      parts.push(`session=${merged.session_id.slice(0, 8)}`);
    }
    if (merged.stage) {
      parts.push(`stage=${merged.stage}`);
    }
    if (merged.operation) {
      parts.push(`op=${merged.operation}`);
    }
    if (merged.component) {
      parts.push(`[${merged.component}]`);
    }

    // Add any extra context keys
    const knownKeys = ['session_id', 'stage', 'operation', 'component'];
    for (const [key, value] of Object.entries(merged)) {
      if (!knownKeys.includes(key) && value !== undefined) {
        parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }

    return parts.length > 0 ? parts.join(' ') : '';
  }

  /**
   * Core log method
   */
  private async log(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const mergedContext = { ...this.defaultContext, ...context };

    // Build log entry for file
    const entry: LogEntry = {
      timestamp,
      level,
      message,
    };

    if (Object.keys(mergedContext).length > 0) {
      entry.context = mergedContext;
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    // Write to file (async, non-blocking)
    writeToFile(entry).catch(() => {});

    // Console output
    const color = LEVEL_COLORS[level];
    const icon = LEVEL_ICONS[level];
    const contextStr = this.formatContextConsole(context);
    const contextPart = contextStr ? ` ${COLORS.cyan}${contextStr}${COLORS.reset}` : '';

    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const levelTag = `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;

    if (error) {
      consoleMethod(`${icon} ${levelTag}${contextPart} ${message}`, error.stack ? `\n${error.stack}` : '');
    } else {
      consoleMethod(`${icon} ${levelTag}${contextPart} ${message}`);
    }
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const err = error instanceof Error ? error : error ? new Error(String(error)) : undefined;
    this.log('error', message, context, err);
  }

  debug(message: string, context?: LogContext): void {
    if (process.env.LOG_LEVEL === 'debug') {
      this.log('debug', message, context);
    }
  }
}

// ============================================================================
// Global Logger Instance
// ============================================================================

export const logger = new Logger();

// ============================================================================
// Convenience Functions (for quick access)
// ============================================================================

export function logInfo(message: string, context?: LogContext): void {
  logger.info(message, context);
}

export function logWarn(message: string, context?: LogContext): void {
  logger.warn(message, context);
}

export function logError(message: string, error?: Error | unknown, context?: LogContext): void {
  logger.error(message, error, context);
}

export function logDebug(message: string, context?: LogContext): void {
  logger.debug(message, context);
}

// ============================================================================
// Session-scoped Logger Factory
// ============================================================================

/**
 * Create a logger pre-configured with session context
 */
export function createSessionLogger(sessionId: string, stage?: string): Logger {
  return logger.child({ session_id: sessionId, stage });
}

/**
 * Create a logger pre-configured for a specific component
 */
export function createComponentLogger(component: string): Logger {
  return logger.child({ component });
}

// ============================================================================
// Default Export
// ============================================================================

export default logger;
