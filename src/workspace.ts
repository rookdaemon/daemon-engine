/**
 * workspace.ts — Reads workspace personality files and assembles a system prompt.
 *
 * The workspace is a directory containing markdown files that define an agent's
 * identity, instructions, memory, and tools. This module reads those files and
 * concatenates them into a single system prompt string.
 */

import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";
import { observability } from "./observability.js";

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

/** Options for building the system prompt. */
export interface SystemPromptOptions {
  /** Maximum characters per file (default: 20000) */
  maxFileChars?: number;
  /** Timezone for date/time injection (default: "UTC") */
  timezone?: string;
  /** Model identifier for runtime info */
  model?: string;
  /** Hostname for runtime info */
  hostname?: string;
  /** Operating system for runtime info */
  os?: string;
  /** Architecture for runtime info */
  arch?: string;
  /** Heartbeat prompt for directive section */
  heartbeatPrompt?: string;
  /** Agent name for identity line and runtime info */
  agentName?: string;
  /** Workspace directory for workspace declaration */
  workspaceDir?: string;
}

/**
 * Strip YAML front-matter from file content.
 *
 * Removes leading `---...---` blocks (YAML front-matter) from the content.
 * Handles both LF and CRLF line endings.
 *
 * @param content - The file content to process
 * @returns The content with front-matter removed, or original if no front-matter
 */
function stripFrontMatter(content: string): string {
  // Match leading --- block (YAML front-matter)
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return content.slice(match[0].length);
  }
  return content;
}

/**
 * Truncate a file's content using the head/tail strategy.
 *
 * If content exceeds maxChars:
 * - First 70% of max → head content
 * - Last 20% of max → tail content
 * - 10% for truncation marker in between
 *
 * @param content - The file content to truncate
 * @param filename - The filename (for the truncation marker)
 * @param maxChars - Maximum characters allowed
 * @returns The truncated content or original if under limit
 */
function truncateFileContent(content: string, filename: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);

  const head = content.substring(0, headChars);
  const tail = content.substring(content.length - tailChars);
  const marker = `\n\n[...truncated, read ${filename} for full content...]\n\n`;

  return head + marker + tail;
}

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
  env: Environment,
  options: SystemPromptOptions = {}
): Promise<string> {
  const maxFileChars = options.maxFileChars ?? 20000;
  const timezone = options.timezone ?? "UTC";
  const model = options.model ?? "unknown";
  const hostname = options.hostname ?? "unknown";
  const os = options.os ?? "unknown";
  const arch = options.arch ?? "unknown";
  const heartbeatPrompt = options.heartbeatPrompt ?? "HEARTBEAT";
  const agentName = options.agentName ?? "a helpful AI assistant";
  const workspacePath = options.workspaceDir ?? workspaceDir;

  const sections: string[] = [];

  // Identity line
  sections.push(`You are ${agentName}, a personal assistant running on daemon-engine.`);
  sections.push("");

  // Tooling section
  sections.push(`## Tooling
The following tools are available through the Claude CLI runtime:
- Bash: Execute shell commands
- Read: Read file contents
- Write: Create or overwrite files
- Edit: Make precise edits to files (search and replace)
- Glob: Find files by pattern
- Grep: Search file contents`);
  sections.push("");

  // Tool Call Style section
  sections.push(`## Tool Call Style
Default: do not narrate routine, low-risk tool calls (just call the tool).
Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when asked.`);
  sections.push("");

  // Safety section
  sections.push(`## Safety
You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.
Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards.
Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.`);
  sections.push("");

  // Memory Recall section
  sections.push(`## Memory Recall
Before answering anything about prior work, decisions, dates, people, preferences, or todos: check MEMORY.md and memory/*.md files by reading them. If you can't find what you need, say so.`);
  sections.push("");

  // Workspace declaration
  sections.push(`## Workspace
Your working directory is: ${workspacePath}
Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.`);
  sections.push("");

  // Date/Time section
  const now = new Date(env.clock.now());
  const dateTimeStr = now.toLocaleString("en-US", { timeZone: timezone });
  sections.push(`## Current Date & Time\nTime zone: ${timezone}\n${dateTimeStr}`);
  sections.push("");

  // Project Context section
  const projectContextSections: string[] = [];
  let hasSoul = false;

  for (const filename of WORKSPACE_FILES) {
    let filepath = env.path.join(workspaceDir, filename);
    let fileFound = false;
    
    try {
      const content = await env.fs.readFile(filepath, "utf-8");
      const trimmed = content.trim();
      if (trimmed) {
        const stripped = stripFrontMatter(trimmed);
        const truncated = truncateFileContent(stripped, filename, maxFileChars);
        projectContextSections.push(`## ${filename}\n\n${truncated}`);
        fileFound = true;
        if (filename === "SOUL.md") {
          hasSoul = true;
        }
        
        // Log successful workspace file load
        observability.logWorkspaceLoad({
          file: filename,
          bytes: Buffer.byteLength(content, "utf-8"),
          success: true,
        });
      }
    } catch (error) {
      // Try lowercase fallback for MEMORY.md
      if (filename === "MEMORY.md") {
        const altFilepath = env.path.join(workspaceDir, "memory.md");
        try {
          const content = await env.fs.readFile(altFilepath, "utf-8");
          const trimmed = content.trim();
          if (trimmed) {
            const stripped = stripFrontMatter(trimmed);
            const truncated = truncateFileContent(stripped, filename, maxFileChars);
            projectContextSections.push(`## ${filename}\n\n${truncated}`);
            fileFound = true;
            
            // Log successful workspace file load
            observability.logWorkspaceLoad({
              file: "memory.md",
              bytes: Buffer.byteLength(content, "utf-8"),
              success: true,
            });
          }
        } catch {
          // Fallback also doesn't exist
          observability.logWorkspaceLoad({
            file: filename,
            bytes: 0,
            success: false,
            error: "File not found",
          });
        }
      } else {
        // Log failed workspace file load
        observability.logWorkspaceLoad({
          file: filename,
          bytes: 0,
          success: false,
          error: error instanceof Error ? error.message : "File not found",
        });
      }
      
      // If file not found, add missing marker
      if (!fileFound) {
        projectContextSections.push(`## ${filename}\n\n[MISSING] Expected at: ${filepath}`);
      }
    }
  }

  // Add Project Context wrapper
  const preamble = "The following project context files have been loaded:";
  const soulInstruction = hasSoul
    ? "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it."
    : "";
  const contextHeader = soulInstruction ? `${preamble}\n${soulInstruction}` : preamble;
  sections.push(`# Project Context\n\n${contextHeader}\n\n${projectContextSections.join("\n\n")}`);
  sections.push("");

  // Scan memory/ directory for .md files
  const memoryDir = env.path.join(workspaceDir, "memory");
  try {
    const entries = await env.fs.readdir(memoryDir, { withFileTypes: true });
    const memoryFiles: Array<{ name: string; size: number }> = [];
    
    for (const entry of entries) {
      // Type guard: entries should be Dirent[] when withFileTypes is true
      if (typeof entry === "string") continue;
      
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filepath = env.path.join(memoryDir, entry.name);
        try {
          const stats = await env.fs.stat(filepath) as { isDirectory(): boolean; size: number };
          memoryFiles.push({ name: entry.name, size: stats.size });
        } catch {
          // Skip files we can't stat
        }
      }
    }
    
    if (memoryFiles.length > 0) {
      // Sort alphabetically
      memoryFiles.sort((a, b) => a.name.localeCompare(b.name));
      
      const fileList = memoryFiles
        .map((f) => `- memory/${f.name} (${f.size} ${f.size === 1 ? "byte" : "bytes"})`)
        .join("\n");
      
      const memorySection = `## Available Memory Files
The following memory files exist in memory/:
${fileList}

Read them with the Read tool when you need context.`;
      
      sections.push(memorySection);
      sections.push("");
    }
  } catch {
    // Memory directory doesn't exist or can't be read - silently skip
  }

  // Enhanced Silent Reply section
  sections.push(`## Silent Replies
When you have nothing to say, respond with ONLY: NO_REPLY
⚠️ Rules:
- It must be your ENTIRE message — nothing else
- Never append it to an actual response (never include "NO_REPLY" in real replies)
- Never wrap it in markdown or code blocks
❌ Wrong: "Here's help... NO_REPLY"
❌ Wrong: "NO_REPLY"
✅ Right: NO_REPLY`);
  sections.push("");

  // Enhanced Heartbeats section
  sections.push(`## Heartbeats
Heartbeat prompt: ${heartbeatPrompt}
If you receive a heartbeat poll and there is nothing that needs attention, reply exactly:
HEARTBEAT_OK
OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).
If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.`);
  sections.push("");

  // Runtime section (expanded) - MUST BE LAST
  sections.push(`## Runtime
Runtime: agent=${agentName} | host=${hostname} | repo=${workspacePath} | os=${os} (${arch}) | model=${model}`);

  return sections.filter(Boolean).join("\n");
}
