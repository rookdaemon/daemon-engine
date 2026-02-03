/**
 * write.ts — Create or overwrite files.
 *
 * Thin wrapper around node:fs writeFile.
 * Creates parent directories if needed.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "../agent.js";

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

  async execute(params: WriteParams): Promise<string> {
    const { path, content } = params;

    // Ensure parent directory exists
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });

    // Write the file
    await writeFile(path, content, "utf-8");

    return `Wrote ${content.length} bytes to ${path}`;
  },
};
