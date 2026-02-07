/**
 * write.ts — Create or overwrite files.
 *
 * Thin wrapper around node:fs writeFile.
 * Creates parent directories if needed.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface WriteParams {
  /** Absolute path to the file to write. */
  path: string;
  /** Content to write to the file. */
  content: string;
}

/**
 * Write tool — creates or overwrites files.
 *
 * Creates parent directories if they don't exist.
 * Overwrites the file if it already exists.
 */
export const write: ToolDefinition<WriteParams> = {
  description: "Create or overwrite a file with the given content.",

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write.",
      },
      content: {
        type: "string",
        description: "Content to write to the file.",
      },
    },
    required: ["path", "content"],
  },

  async execute(params: WriteParams, context: ToolContext): Promise<string> {
    return await writeWithEnv(params, context.env);
  },
};

export async function writeWithEnv(
  params: WriteParams,
  env: Environment
): Promise<string> {
  const { path, content } = params;

  // Ensure parent directory exists
  const dir = env.path.dirname(path);
  await env.fs.mkdir(dir, { recursive: true });

  // Write the file
  await env.fs.writeFile(path, content, "utf-8");

  return `Wrote ${content.length} bytes to ${path}`;
}
