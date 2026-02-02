/**
 * workspace.ts — Reads workspace personality files and assembles a system prompt.
 *
 * The workspace is a directory containing markdown files that define an agent's
 * identity, instructions, memory, and tools. This module reads those files and
 * concatenates them into a single system prompt string.
 */
/** The ordered list of workspace files to include in the system prompt. */
export declare const WORKSPACE_FILES: readonly string[];
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
export declare function buildSystemPrompt(workspaceDir: string): Promise<string>;
