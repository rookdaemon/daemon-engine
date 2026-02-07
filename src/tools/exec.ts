/**
 * exec.ts — Execute shell commands with timeout.
 *
 * Thin wrapper around node:child_process execFile.
 * Runs commands with a configurable timeout.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface ExecParams {
  /** Command to execute. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Working directory for command execution. */
  cwd?: string;
  /** Timeout in milliseconds (default: 30000). */
  timeout?: number;
}

/**
 * Exec tool — runs shell commands with timeout.
 *
 * Executes a command and returns its stdout.
 * Throws if the command fails or times out.
 */
export const exec: ToolDefinition<ExecParams> = {
  description: "Execute a shell command with a timeout.",

  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Command to execute.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the command.",
      },
      cwd: {
        type: "string",
        description: "Working directory for command execution.",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000).",
      },
    },
    required: ["command"],
  },

  async execute(params: ExecParams, context: ToolContext): Promise<string> {
    return await execWithEnv(params, context.env);
  },
};

export async function execWithEnv(
  params: ExecParams,
  env: Environment
): Promise<string> {
  const { command, args = [], cwd, timeout = 30000 } = params;

  try {
    const { stdout, stderr } = await env.subprocess.execFile(command, args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Return stdout, append stderr if present
    let result = stdout;
    if (stderr) {
      result += `\n[stderr]\n${stderr}`;
    }
    return result;
  } catch (error) {
    if (error instanceof Error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      let message = `Command failed: ${err.message}`;
      if (err.stdout) message += `\n[stdout]\n${err.stdout}`;
      if (err.stderr) message += `\n[stderr]\n${err.stderr}`;
      throw new Error(message);
    }
    throw error;
  }
}
