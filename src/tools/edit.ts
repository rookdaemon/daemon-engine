/**
 * edit.ts — Surgical file editing via string replacement.
 *
 * Performs targeted string replacement in files without requiring full-file overwrites.
 * Validates uniqueness of search strings to prevent ambiguous edits.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface EditParams {
  /** Absolute path to the file to edit. */
  path: string;
  /** The exact string to find and replace. Must be unique in the file unless replace_all is true. */
  old_string: string;
  /** The replacement string. */
  new_string: string;
  /** If true, replace all occurrences. Default: false. */
  replace_all?: boolean;
}

/**
 * Edit tool — performs surgical string replacement in files.
 *
 * Validates that the old_string exists and is unique (unless replace_all=true).
 * Prevents accidental data loss by requiring explicit replace_all for multiple matches.
 */
export const edit: ToolDefinition<EditParams> = {
  description: "Edit a file by replacing an exact string. The old_string must be unique unless replace_all is true.",

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit.",
      },
      old_string: {
        type: "string",
        description: "The exact string to find in the file. Must be unique unless replace_all is true.",
      },
      new_string: {
        type: "string",
        description: "The string to replace old_string with.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false).",
      },
    },
    required: ["path", "old_string", "new_string"],
  },

  async execute(params: EditParams, context: ToolContext): Promise<string> {
    return await editWithEnv(params, context.env);
  },
};

export async function editWithEnv(
  params: EditParams,
  env: Environment
): Promise<string> {
  const { path, old_string, new_string, replace_all = false } = params;

  // Validate that old_string and new_string are different
  if (old_string === new_string) {
    throw new Error("old_string and new_string are identical");
  }

  // Read the file
  const content = await env.fs.readFile(path, "utf-8");

  // Count occurrences of old_string
  const occurrences = content.split(old_string).length - 1;

  if (occurrences === 0) {
    throw new Error(`old_string not found in ${path}`);
  }

  if (!replace_all && occurrences > 1) {
    throw new Error(
      `old_string is not unique in ${path} (found ${occurrences} occurrences). Use replace_all: true or provide more context.`
    );
  }

  // Perform the replacement
  const result = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string);

  // Write the result back
  await env.fs.writeFile(path, result, "utf-8");

  return `Edited ${path}: replaced ${replace_all ? occurrences : 1} occurrence(s)`;
}
