/**
 * claude-cli-verbose-logger.ts — Detailed logging for Claude CLI subprocess.
 *
 * Captures every detail of Claude CLI execution for debugging:
 * - Full command line and environment
 * - Real-time stdout/stderr as they arrive
 * - Timing information
 * - Detection of prompts/waits
 * - Exit codes and signals
 */

import type { Environment } from "../env/environment.js";
import { appendFileSync, writeFileSync } from "node:fs";

let verboseLogPath: string | null = null;

/**
 * Initialize verbose Claude CLI logging.
 */
export function initClaudeVerboseLogging(filePath: string, env: Environment): void {
  verboseLogPath = filePath;
  void env; // Reserved for future per-invocation env logging
  // Write init message synchronously to ensure file creation
  try {
    writeFileSync(filePath, `\n${"=".repeat(80)}\n[${new Date().toISOString()}] Claude CLI Verbose Logging Initialized\n${"=".repeat(80)}\n`, "utf-8");
  } catch (error) {
    console.error(`[verbose-logger] Failed to initialize: ${error}`);
  }
}

/**
 * Append to verbose log file.
 */
function appendVerbose(content: string): void {
  if (!verboseLogPath) {
    return;
  }

  // Use synchronous append for simplicity (this is debugging infrastructure)
  try {
    appendFileSync(verboseLogPath, content, "utf-8");
  } catch {
    // Logging errors must not crash the daemon
  }
}

/**
 * Log a Claude CLI invocation start.
 */
export function logClaudeStart(args: string[], cwd: string | undefined, env: Record<string, string>): string {
  const invocationId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const timestamp = new Date().toISOString();
  
  const logEntry = `
${"=".repeat(80)}
[${timestamp}] CLAUDE CLI INVOCATION START
Invocation ID: ${invocationId}
${"=".repeat(80)}

COMMAND:
  claude ${args.join(" ")}

WORKING DIRECTORY:
  ${cwd || process.cwd()}

ENVIRONMENT:
${Object.entries(env).map(([k, v]) => `  ${k}=${v}`).join("\n")}

STDOUT:
`;
  
  appendVerbose(logEntry);
  return invocationId;
}

/**
 * Log real-time stdout data.
 */
export function logClaudeStdout(invocationId: string, chunk: Buffer | string): void {
  const text = chunk.toString();
  appendVerbose(text);
  
  // Detect potential wait states
  if (text.includes("?") || text.includes("(y/n)") || text.includes("Continue?")) {
    const timestamp = new Date().toISOString();
    appendVerbose(`\n⚠️  [${timestamp}] POTENTIAL WAIT STATE DETECTED ⚠️\n`);
  }
}

/**
 * Log real-time stderr data.
 */
export function logClaudeStderr(invocationId: string, chunk: Buffer | string): void {
  const text = chunk.toString();
  const timestamp = new Date().toISOString();
  appendVerbose(`\n--- STDERR [${timestamp}] ---\n${text}\n--- END STDERR ---\n`);
}

/**
 * Log Claude CLI invocation end.
 */
export function logClaudeEnd(
  invocationId: string,
  exitCode: number | null,
  signal: string | null,
  durationMs: number
): void {
  const timestamp = new Date().toISOString();
  const exitInfo = signal ? `SIGNAL: ${signal}` : `EXIT CODE: ${exitCode}`;
  
  const logEntry = `
${"=".repeat(80)}
[${timestamp}] CLAUDE CLI INVOCATION END
Invocation ID: ${invocationId}
Duration: ${durationMs}ms
${exitInfo}
${"=".repeat(80)}

`;
  
  appendVerbose(logEntry);
}

/**
 * Log an error during Claude CLI execution.
 */
export function logClaudeError(invocationId: string, error: Error): void {
  const timestamp = new Date().toISOString();
  
  const logEntry = `
❌ [${timestamp}] ERROR
Invocation ID: ${invocationId}
${error.message}
${error.stack || ""}

`;
  
  appendVerbose(logEntry);
}

/**
 * Flush all pending verbose log writes.
 * (No-op since we use synchronous writes)
 */
export function flushClaudeVerboseLog(): Promise<void> {
  return Promise.resolve();
}
