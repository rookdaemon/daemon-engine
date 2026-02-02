/**
 * workspace.ts — Reads workspace personality files and assembles a system prompt.
 *
 * The workspace is a directory containing markdown files that define an agent's
 * identity, instructions, memory, and tools. This module reads those files and
 * concatenates them into a single system prompt string.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The ordered list of workspace files to include in the system prompt. */
export const WORKSPACE_FILES: readonly string[] = [
  "SOUL.md",
  "AGENTS.md",
  "USER.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

/**
 * Build a system prompt string from workspace files.
 *
 * Reads each file in {@link WORKSPACE_FILES} from the given directory.
 * Missing files are silently skipped. Each present file is included with
 * a `## filename` header. Returns empty string if no files are found.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @returns The assembled system prompt string.
 */
export async function buildSystemPrompt(workspaceDir: string): Promise<string> {
  const sections: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    const filepath = join(workspaceDir, filename);
    try {
      const content = await readFile(filepath, "utf-8");
      const trimmed = content.trim();
      if (trimmed) {
        sections.push(`## ${filename}\n${trimmed}`);
      }
    } catch {
      // File doesn't exist — skip it
    }
  }

  return sections.join("\n\n");
}
