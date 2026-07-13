/**
 * Structured JSON logger.
 *
 * Zero external dependencies — outputs newline-delimited JSON to stdout
 * (info and below) or stderr (warn and above).  In non-production
 * environments the format is prettified for readability.
 *
 * Usage:
 *   import { logger } from '../observability/logger';
 *   logger.info('Server started', { port: 5000 });
 *
 * Child logger (binds context into every line):
 *   const reqLog = logger.child({ requestId: 'abc', userId: '123' });
 *   reqLog.info('Request received');
 *
 * Log levels (numeric, lowest→highest):
 *   trace(10) debug(20) info(30) warn(40) error(50) fatal(60)
 *
 * Set LOG_LEVEL env var to control minimum level (default: "info").
 *
 * Security: every record is piped through `redactLogRecord` before it is written, so
 * emails, phone numbers, card/SSN-like numbers, bearer/provider tokens, and health or
 * biometric markers (steps, heart rate, calories, sleep, glucose, …) can never be cached
 * in Interlink logs — the HIPAA/GDPR requirement. Do not rely on that as an excuse to log
 * secrets deliberately, but it is a hard backstop.
 */

import { redactLogRecord } from "../security/redact";

// ─── Level definitions ────────────────────────────────────────────────────────

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LogLevel = keyof typeof LEVELS;

function resolveMinLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

// ─── Logger class ─────────────────────────────────────────────────────────────

export class Logger {
  private readonly bindings: Record<string, unknown>;
  private readonly minLevel: number;
  private readonly isDev: boolean;

  constructor(
    bindings: Record<string, unknown> = {},
    minLevel: number = resolveMinLevel(),
  ) {
    this.bindings = bindings;
    this.minLevel = minLevel;
    this.isDev = process.env.NODE_ENV !== "production";
  }

  /** Create a child logger with additional bound context fields. */
  child(extra: Record<string, unknown>): Logger {
    return new Logger({ ...this.bindings, ...extra }, this.minLevel);
  }

  private write(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown> | Error,
  ): void {
    if (LEVELS[level] < this.minLevel) return;

    const numeric = LEVELS[level];
    const isError = numeric >= LEVELS.warn;

    // Build the log record.
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: numeric,
      levelName: level,
      ...this.bindings,
      msg,
    };

    // Merge extra data.  If caller passed an Error, serialize it.
    if (data instanceof Error) {
      record.err = {
        message: data.message,
        name: data.name,
        stack: data.stack,
      };
    } else if (data != null) {
      Object.assign(record, data);
    }

    // Hard backstop: scrub PII / health markers / secrets from EVERY record before it
    // is written. No caller can accidentally cache sensitive data in the logs.
    const safe = redactLogRecord(record);

    const line = this.isDev
      ? prettyFormat(level, safe)
      : JSON.stringify(safe);

    if (isError) {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.write("trace", msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.write("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown> | Error): void {
    this.write("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown> | Error): void {
    this.write("error", msg, data);
  }
  fatal(msg: string, data?: Record<string, unknown> | Error): void {
    this.write("fatal", msg, data);
  }
}

// ─── Dev pretty formatter ─────────────────────────────────────────────────────

const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: " INFO",
  warn: " WARN",
  error: "ERROR",
  fatal: "FATAL",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[37m", // white
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  fatal: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function prettyFormat(
  level: LogLevel,
  record: Record<string, unknown>,
): string {
  const color = LEVEL_COLORS[level];
  const label = LEVEL_LABELS[level];
  const { time, levelName: _l, level: _n, msg, err, ...rest } = record;

  // Build context string from remaining fields (skip noisy/empty ones).
  const ctx = Object.entries(rest)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${DIM}${k}=${RESET}${String(v)}`)
    .join(" ");

  let line = `${DIM}${time}${RESET} ${color}${label}${RESET} ${msg}`;
  if (ctx) line += `  ${ctx}`;

  if (err && typeof err === "object") {
    const e = err as { message?: string; stack?: string };
    line += `\n  ${color}${e.message}${RESET}`;
    if (e.stack) {
      const frames = e.stack
        .split("\n")
        .slice(1)
        .map((f) => `    ${DIM}${f.trim()}${RESET}`)
        .join("\n");
      line += `\n${frames}`;
    }
  }

  return line;
}

// ─── Singleton root logger ────────────────────────────────────────────────────

/** Root application logger.  Bind context via `.child()`. */
export const logger = new Logger({ service: "interlink" });

/**
 * Create a worker-scoped child logger with queue + job context.
 *
 * Usage in processors:
 *   const log = createWorkerLogger('workflow', job.id, { executionId });
 */
export function createWorkerLogger(
  queue: string,
  jobId?: string,
  extra?: Record<string, unknown>,
): Logger {
  return logger.child({ queue, jobId: jobId ?? null, ...extra });
}
