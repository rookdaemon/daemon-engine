/**
 * workspace.ts — Reads workspace personality files and assembles a system prompt.
 *
 * The workspace is a directory containing markdown files that define an agent's
 * identity, instructions, memory, and tools. This module reads those files and
 * concatenates them into a single system prompt string.
 */

import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";

/** The ordered list of workspace files to include in the system prompt. */
export const WORKSPACE_FILES: readonly string[] = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

/**
 * Build a system prompt string from workspace files.
 *
 * Reads each file in {@link WORKSPACE_FILES} from the given directory.
 * Missing files produce a `[MISSING]` marker in the output. Each present
 * file is included with a `## filename` header. For MEMORY.md, falls back
 * to lowercase memory.md if MEMORY.md is not found.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @returns The assembled system prompt string with file contents or [MISSING] markers.
 */
export async function buildSystemPrompt(workspaceDir: string): Promise<string> {
  return await buildSystemPromptWithEnv(workspaceDir, createNodeEnvironment());
}

export async function buildSystemPromptWithEnv(
  workspaceDir: string,
  env: Environment
): Promise<string> {
  const sections: string[] = [];

  for (const filename of WORKSPACE_FILES) {
    let filepath = env.path.join(workspaceDir, filename);
    let fileFound = false;
    
    try {
      const content = await env.fs.readFile(filepath, "utf-8");
      const trimmed = content.trim();
      if (trimmed) {
        sections.push(`## ${filename}\n${trimmed}`);
        fileFound = true;
      }
    } catch {
      // Try lowercase fallback for MEMORY.md
      if (filename === "MEMORY.md") {
        const altFilepath = env.path.join(workspaceDir, "memory.md");
        try {
          const content = await env.fs.readFile(altFilepath, "utf-8");
          const trimmed = content.trim();
          if (trimmed) {
            sections.push(`## ${filename}\n${trimmed}`);
            fileFound = true;
          }
        } catch {
          // Fallback also doesn't exist
        }
      }
      
      // If file not found, add missing marker
      if (!fileFound) {
        sections.push(`## ${filename}\n[MISSING] Expected at: ${filepath}`);
      }
    }
  }

  return sections.join("\n\n");
}
