/**
 * logger.ts — Timestamped logging with file output and basic rotation.
 *
 * Provides a simple logger that prepends ISO 8601 timestamps to all log
 * messages, writes to both console and a log file, and rotates the log
 * file when it exceeds a size threshold.
 */

import type { Environment } from "./env/environment.js";
import { observability } from "./observability.js";

/** Maximum log file size in bytes before rotation (5 MB). */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** Number of rotated log files to keep. */
const MAX_ROTATED_FILES = 3;

let logFilePath: string | null = null;
let logEnv: Environment | null = null;
let bytesWritten = 0;

/** Promise chain that serializes all file writes. */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Initialize the logger with a file path for persistent log output.
 *
 * Must be called before using log.info / log.error if file logging
 * is desired. Console output works regardless of initialization.
 */
export function initLogger(filePath: string, env: Environment): void {
  logFilePath = filePath;
  logEnv = env;
  bytesWritten = 0;
  writeChain = Promise.resolve();
  log.info("[logger]", `Logging to ${filePath}`);
}

/**
 * Flush all pending log writes. Returns when every queued write
 * has completed (or silently failed).
 */
export function flushLogger(): Promise<void> {
  return writeChain;
}

/**
 * Reset the logger (for testing).
 */
export function resetLogger(): void {
  logFilePath = null;
  logEnv = null;
  bytesWritten = 0;
  writeChain = Promise.resolve();
}

/**
 * Format a log line with an ISO 8601 timestamp.
 */
function formatLine(level: string, prefix: string, message: string, now: number): string {
  const ts = new Date(now).toISOString();
  return `${ts} ${level} ${prefix} ${message}`;
}

function writeStdout(line: string): void {
  console.log(line);
}

function writeStderr(line: string): void {
  console.error(line);
}

/**
 * Rotate the log file when it exceeds MAX_LOG_SIZE.
 *
 * Rotation scheme:  daemon-engine.log -> .1 -> .2 -> .3 (deleted)
 * Errors during rotation are silently ignored — logging must not
 * break the daemon.
 */
async function rotate(env: Environment, filePath: string): Promise<void> {
  try {
    // Shift existing rotated files: .2 -> .3, .1 -> .2
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const dst = `${filePath}.${i}`;
      try {
        const data = await env.fs.readFile(src, "utf-8");
        await env.fs.writeFile(dst, data, "utf-8");
      } catch {
        // Source doesn't exist — skip.
      }
    }

    // Copy current log to .1 then truncate.
    try {
      const data = await env.fs.readFile(filePath, "utf-8");
      await env.fs.writeFile(`${filePath}.1`, data, "utf-8");
    } catch {
      // Ignore.
    }

    // Truncate the active log file.
    await env.fs.writeFile(filePath, "", "utf-8");
    bytesWritten = 0;
  } catch {
    // Rotation must never crash the daemon.
  }
}

/**
 * Enqueue a line to be written to the log file.
 *
 * Writes are serialized via a promise chain so they never race.
 * The chain is fire-and-forget from the caller's perspective.
 */
function appendToFile(line: string): void {
  if (!logFilePath || !logEnv) return;
  const env = logEnv;
  const filePath = logFilePath;
  const data = line + "\n";
  const dataBytes = Buffer.byteLength(data, "utf-8");

  writeChain = writeChain.then(async () => {
    try {
      // Rotate if we've exceeded the size threshold.
      if (bytesWritten >= MAX_LOG_SIZE) {
        await rotate(env, filePath);
      }
      await env.fs.writeFileAppend(filePath, data, "utf-8");
      bytesWritten += dataBytes;
    } catch {
      // Logging I/O errors must not crash the daemon.
    }
  });
}

/**
 * Logger namespace with info and error helpers.
 */
export const log = {
  /**
   * Log an informational message to stdout and the log file.
   */
  info(prefix: string, message: string): void {
    // Bootstrap-only fallback: before initLogger(), use Date.now(). After initLogger(), logEnv.clock.now() is used for testability.
    const now = logEnv ? logEnv.clock.now() : Date.now();
    const line = formatLine("INFO", prefix, message, now);
    writeStdout(line);
    appendToFile(line);
    
    // Also log to observability collector
    observability.info(prefix, message, undefined, now);
  },

  /**
   * Log an error message to stderr and the log file.
   */
  error(prefix: string, message: string): void {
    // Bootstrap-only fallback: before initLogger(), use Date.now(). After initLogger(), logEnv.clock.now() is used for testability.
    const now = logEnv ? logEnv.clock.now() : Date.now();
    const line = formatLine("ERROR", prefix, message, now);
    writeStderr(line);
    appendToFile(line);
    
    // Also log to observability collector
    observability.error(prefix, message, undefined, now);
  },

  /**
   * Write raw output to stdout without formatting.
   */
  raw(message: string): void {
    process.stdout.write(message);
  },
};
