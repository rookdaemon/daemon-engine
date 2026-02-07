/**
 * read.ts — Read file contents or list directory entries.
 *
 * Thin wrapper around node:fs readFile and readdir.
 * Reads text files or lists directories.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface ReadParams {
  /** Absolute path to file or directory to read. */
  path: string;
}

/**
 * Read tool — reads file contents or lists directory entries.
 *
 * For files: returns the text content.
 * For directories: returns a newline-separated list of entries.
 */
export const read: ToolDefinition<ReadParams> = {
  description: "Read file contents (text) or list directory entries.",

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file or directory to read.",
      },
    },
    required: ["path"],
  },

  async execute(params: ReadParams, context: ToolContext): Promise<string> {
    return await readWithEnv(params, context.env);
  },
};

export async function readWithEnv(
  params: ReadParams,
  env: Environment
): Promise<string> {
  const { path } = params;

  // Check if path is a file or directory
  const stats = await env.fs.stat(path);

  if (stats.isDirectory()) {
    // List directory contents
    const entries = await env.fs.readdir(path);
    return (entries as string[]).join("\n");
  } else {
    // Read file contents
    return await env.fs.readFile(path, "utf-8");
  }
}
