import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, WORKSPACE_FILES } from "../src/workspace.js";

describe("buildSystemPrompt", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "daemon-engine-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("assembles all workspace files into a system prompt", async () => {
    await writeFile(join(workDir, "SOUL.md"), "I am a test daemon.");
    await writeFile(join(workDir, "AGENTS.md"), "Follow instructions.");
    await writeFile(join(workDir, "USER.md"), "The user is a tester.");
    await writeFile(join(workDir, "MEMORY.md"), "I remember things.");
    await writeFile(join(workDir, "TOOLS.md"), "Use the tools wisely.");
    await writeFile(join(workDir, "HEARTBEAT.md"), "Check stuff.");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("I am a test daemon.");
    expect(prompt).toContain("Follow instructions.");
    expect(prompt).toContain("The user is a tester.");
    expect(prompt).toContain("I remember things.");
    expect(prompt).toContain("Use the tools wisely.");
    expect(prompt).toContain("Check stuff.");
  });

  it("includes section headers for each file", async () => {
    await writeFile(join(workDir, "SOUL.md"), "soul content");
    await writeFile(join(workDir, "AGENTS.md"), "agents content");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("## AGENTS.md");
  });

  it("includes [MISSING] markers for absent files", async () => {
    await writeFile(join(workDir, "SOUL.md"), "Just a soul.");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("Just a soul.");
    expect(prompt).toContain("[MISSING]");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("## BOOTSTRAP.md");
  });

  it("includes [MISSING] markers for empty workspace", async () => {
    const prompt = await buildSystemPrompt(workDir);
    
    expect(prompt).toContain("[MISSING]");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("## TOOLS.md");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("## USER.md");
    expect(prompt).toContain("## HEARTBEAT.md");
    expect(prompt).toContain("## BOOTSTRAP.md");
    expect(prompt).toContain("## MEMORY.md");
  });

  it("exports the list of workspace files in OpenClaw order", () => {
    expect(WORKSPACE_FILES).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
  });

  it("trims whitespace from file contents", async () => {
    await writeFile(join(workDir, "SOUL.md"), "  padded content  \n\n");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("padded content");
    expect(prompt).not.toMatch(/  padded/);
  });

  it("falls back to lowercase memory.md when MEMORY.md is missing", async () => {
    await writeFile(join(workDir, "memory.md"), "lowercase memory content");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## MEMORY.md");
    expect(prompt).toContain("lowercase memory content");
    // Verify MEMORY.md section doesn't have [MISSING]
    const memorySection = prompt.split("## MEMORY.md")[1]?.split("##")[0] || "";
    expect(memorySection).not.toContain("[MISSING]");
    expect(memorySection).toContain("lowercase memory content");
  });

  it("prefers MEMORY.md over lowercase memory.md when both exist", async () => {
    await writeFile(join(workDir, "MEMORY.md"), "uppercase memory");
    await writeFile(join(workDir, "memory.md"), "lowercase memory");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("uppercase memory");
    expect(prompt).not.toContain("lowercase memory");
  });

  it("includes full path in [MISSING] markers", async () => {
    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain(`[MISSING] Expected at: ${join(workDir, "AGENTS.md")}`);
    expect(prompt).toContain(`[MISSING] Expected at: ${join(workDir, "IDENTITY.md")}`);
    expect(prompt).toContain(`[MISSING] Expected at: ${join(workDir, "BOOTSTRAP.md")}`);
  });

  it("loads all 8 files with new additions", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "agents");
    await writeFile(join(workDir, "SOUL.md"), "soul");
    await writeFile(join(workDir, "TOOLS.md"), "tools");
    await writeFile(join(workDir, "IDENTITY.md"), "identity");
    await writeFile(join(workDir, "USER.md"), "user");
    await writeFile(join(workDir, "HEARTBEAT.md"), "heartbeat");
    await writeFile(join(workDir, "BOOTSTRAP.md"), "bootstrap");
    await writeFile(join(workDir, "MEMORY.md"), "memory");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("agents");
    expect(prompt).toContain("soul");
    expect(prompt).toContain("tools");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("user");
    expect(prompt).toContain("heartbeat");
    expect(prompt).toContain("bootstrap");
    expect(prompt).toContain("memory");
    expect(prompt).not.toContain("[MISSING]");
  });

  it("maintains OpenClaw file ordering in output", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "1-agents");
    await writeFile(join(workDir, "SOUL.md"), "2-soul");
    await writeFile(join(workDir, "TOOLS.md"), "3-tools");
    await writeFile(join(workDir, "IDENTITY.md"), "4-identity");
    await writeFile(join(workDir, "USER.md"), "5-user");
    await writeFile(join(workDir, "HEARTBEAT.md"), "6-heartbeat");
    await writeFile(join(workDir, "BOOTSTRAP.md"), "7-bootstrap");
    await writeFile(join(workDir, "MEMORY.md"), "8-memory");

    const prompt = await buildSystemPrompt(workDir);

    const agentsIdx = prompt.indexOf("1-agents");
    const soulIdx = prompt.indexOf("2-soul");
    const toolsIdx = prompt.indexOf("3-tools");
    const identityIdx = prompt.indexOf("4-identity");
    const userIdx = prompt.indexOf("5-user");
    const heartbeatIdx = prompt.indexOf("6-heartbeat");
    const bootstrapIdx = prompt.indexOf("7-bootstrap");
    const memoryIdx = prompt.indexOf("8-memory");

    expect(agentsIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(heartbeatIdx);
    expect(heartbeatIdx).toBeLessThan(bootstrapIdx);
    expect(bootstrapIdx).toBeLessThan(memoryIdx);
  });

  it("includes Project Context header with SOUL.md instruction", async () => {
    await writeFile(join(workDir, "SOUL.md"), "I am helpful");
    await writeFile(join(workDir, "AGENTS.md"), "Follow rules");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("Embody the persona and tone defined in SOUL.md");
  });

  it("includes Project Context header without SOUL.md instruction when SOUL.md is missing", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "Follow rules");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("# Project Context");
    expect(prompt).not.toContain("Embody the persona and tone defined in SOUL.md");
  });

  it("includes date/time section with timezone", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Current Date & Time");
    expect(prompt).toContain("Time zone: UTC");
  });

  it("includes runtime info section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Runtime");
    expect(prompt).toContain("Runtime: agent=");
    expect(prompt).toContain("| host=");
    expect(prompt).toContain("| repo=");
    expect(prompt).toContain("| os=");
    expect(prompt).toContain("| model=");
  });

  it("includes silent reply section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Silent Replies");
    expect(prompt).toContain("NO_REPLY");
  });

  it("includes heartbeats section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("truncates files exactly at the limit", async () => {
    const content = "a".repeat(20000);
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    // Should not be truncated at exactly 20000 chars
    expect(prompt).toContain("a".repeat(20000));
    expect(prompt).not.toContain("truncated");
  });

  it("truncates files just over the limit with head/tail strategy", async () => {
    const content = "a".repeat(20001);
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    // Should contain truncation marker
    expect(prompt).toContain("[...truncated, read SOUL.md for full content...]");
    
    // Should contain head portion (70% = 14000 chars)
    const headChars = Math.floor(20001 * 0.7);
    expect(prompt).toContain("a".repeat(headChars));
    
    // Should not contain the full content
    expect(prompt).not.toContain("a".repeat(20001));
  });

  it("handles empty files without including them", async () => {
    await writeFile(join(workDir, "SOUL.md"), "");
    await writeFile(join(workDir, "AGENTS.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    // Empty files should show as MISSING
    expect(prompt).toContain("[MISSING]");
  });

  it("uses custom timezone in date/time section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      timezone: "Europe/Stockholm",
    });

    expect(prompt).toContain("Time zone: Europe/Stockholm");
  });

  it("uses custom maxFileChars for truncation", async () => {
    const content = "b".repeat(1001);
    await writeFile(join(workDir, "SOUL.md"), content);
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      maxFileChars: 1000,
    });

    // Should be truncated with a smaller limit
    expect(prompt).toContain("[...truncated, read SOUL.md for full content...]");
  });

  it("includes runtime info from options", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      model: "claude-opus",
      hostname: "test-host",
      os: "linux",
      arch: "x64",
    });

    expect(prompt).toContain("model=claude-opus");
    expect(prompt).toContain("host=test-host");
    expect(prompt).toContain("os=linux");
    expect(prompt).toContain("(x64)");
  });

  it("uses custom heartbeat prompt in heartbeats section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      heartbeatPrompt: "CUSTOM_HEARTBEAT_PROMPT",
    });

    expect(prompt).toContain("Heartbeat prompt: CUSTOM_HEARTBEAT_PROMPT");
  });

  it("strips YAML front-matter from file with LF line endings", async () => {
    const content = "---\ntitle: Test\nauthor: Agent\n---\nActual content here.";
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("Actual content here.");
    expect(prompt).not.toContain("title: Test");
    expect(prompt).not.toContain("author: Agent");
  });

  it("strips YAML front-matter from file with CRLF line endings", async () => {
    const content = "---\r\ntitle: Test\r\nauthor: Agent\r\n---\r\nActual content here.";
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("Actual content here.");
    expect(prompt).not.toContain("title: Test");
    expect(prompt).not.toContain("author: Agent");
  });

  it("preserves content when there is no front-matter", async () => {
    const content = "This is just regular content without front-matter.";
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("This is just regular content without front-matter.");
  });

  it("handles file with only front-matter (empty after stripping)", async () => {
    const content = "---\ntitle: Only Front Matter\n---\n";
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    // Empty file after stripping should be treated as missing
    expect(prompt).toContain("[MISSING]");
    expect(prompt).not.toContain("title: Only Front Matter");
  });

  it("strips front-matter from all workspace files", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "---\ntype: agent\n---\nAgent instructions");
    await writeFile(join(workDir, "SOUL.md"), "---\npersona: helpful\n---\nSoul content");
    await writeFile(join(workDir, "TOOLS.md"), "---\ntools: yes\n---\nTool guidance");
    await writeFile(join(workDir, "USER.md"), "---\nuser: test\n---\nUser info");
    await writeFile(join(workDir, "MEMORY.md"), "---\nmemory: true\n---\nMemory content");

    const prompt = await buildSystemPrompt(workDir);

    // Should contain actual content
    expect(prompt).toContain("Agent instructions");
    expect(prompt).toContain("Soul content");
    expect(prompt).toContain("Tool guidance");
    expect(prompt).toContain("User info");
    expect(prompt).toContain("Memory content");

    // Should NOT contain front-matter
    expect(prompt).not.toContain("type: agent");
    expect(prompt).not.toContain("persona: helpful");
    expect(prompt).not.toContain("tools: yes");
    expect(prompt).not.toContain("user: test");
    expect(prompt).not.toContain("memory: true");
  });

  it("preserves dashes that are not front-matter", async () => {
    const content = "Content with --- in the middle\n---\nNot front-matter";
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("Content with --- in the middle");
    expect(prompt).toContain("Not front-matter");
  });

  it("strips front-matter before truncation", async () => {
    // Create content that is large but with front-matter
    const frontMatter = "---\ntitle: Large File\n---\n";
    const actualContent = "a".repeat(20001);
    const content = frontMatter + actualContent;
    await writeFile(join(workDir, "SOUL.md"), content);

    const prompt = await buildSystemPrompt(workDir);

    // Should not contain front-matter
    expect(prompt).not.toContain("title: Large File");
    // Should contain truncation marker because actual content exceeds limit
    expect(prompt).toContain("[...truncated, read SOUL.md for full content...]");
    // Should contain some of the actual content
    expect(prompt).toContain("aaaa");
  });

  it("handles missing memory directory gracefully", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    // Should not crash and should not mention memory files
    expect(prompt).not.toContain("## Available Memory Files");
  });

  it("handles empty memory directory gracefully", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "memory"));
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    // Should not crash and should not mention memory files
    expect(prompt).not.toContain("## Available Memory Files");
  });

  it("lists memory/*.md files with sizes", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "memory"));
    await writeFile(join(workDir, "memory/2026-02-03.md"), "Day 3 notes");
    await writeFile(join(workDir, "memory/2026-02-04.md"), "Day 4");
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Available Memory Files");
    expect(prompt).toContain("memory/2026-02-03.md");
    expect(prompt).toContain("memory/2026-02-04.md");
    // Should show file sizes in bytes
    expect(prompt).toMatch(/2026-02-03\.md.*\d+ bytes?\)/);
    expect(prompt).toMatch(/2026-02-04\.md.*\d+ bytes?\)/);
    // Should tell agent to use Read tool
    expect(prompt).toContain("Read tool");
  });

  it("only lists .md files from memory directory", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "memory"));
    await writeFile(join(workDir, "memory/2026-02-03.md"), "Day 3");
    await writeFile(join(workDir, "memory/heartbeat-state.json"), "{}");
    await writeFile(join(workDir, "memory/notes.txt"), "text notes");
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Available Memory Files");
    expect(prompt).toContain("memory/2026-02-03.md");
    expect(prompt).not.toContain("heartbeat-state.json");
    expect(prompt).not.toContain("notes.txt");
  });

  it("sorts memory files alphabetically", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(workDir, "memory"));
    await writeFile(join(workDir, "memory/zebra.md"), "z");
    await writeFile(join(workDir, "memory/alpha.md"), "a");
    await writeFile(join(workDir, "memory/beta.md"), "b");
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    const alphaIdx = prompt.indexOf("memory/alpha.md");
    const betaIdx = prompt.indexOf("memory/beta.md");
    const zebraIdx = prompt.indexOf("memory/zebra.md");

    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(zebraIdx);
  });

  // Tests for new system prompt sections

  it("includes identity line with default agent name", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("You are a helpful AI assistant, a personal assistant running on daemon-engine.");
  });

  it("includes identity line with custom agent name", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      agentName: "Rook",
    });

    expect(prompt).toContain("You are Rook, a personal assistant running on daemon-engine.");
  });

  it("includes tooling section with all available tools", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("The following tools are available through the Claude CLI runtime:");
    expect(prompt).toContain("- Bash: Execute shell commands");
    expect(prompt).toContain("- Read: Read file contents");
    expect(prompt).toContain("- Write: Create or overwrite files");
    expect(prompt).toContain("- Edit: Make precise edits to files (search and replace)");
    expect(prompt).toContain("- Glob: Find files by pattern");
    expect(prompt).toContain("- Grep: Search file contents");
  });

  it("includes tool call style section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("Default: do not narrate routine, low-risk tool calls (just call the tool).");
    expect(prompt).toContain("Narrate only when it helps: multi-step work, complex problems, sensitive actions, or when asked.");
  });

  it("includes safety section with all guidelines", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("- Do not pursue self-preservation or replication as goals");
    expect(prompt).toContain("- Prioritize safety and human oversight");
    expect(prompt).toContain("- Do not manipulate or deceive to expand access");
    expect(prompt).toContain("- When uncertain about safety implications, ask the user");
  });

  it("includes memory recall section", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("Before answering anything about prior work, decisions, dates, people, preferences, or todos: check MEMORY.md and memory/*.md files by reading them.");
    expect(prompt).toContain("If you can't find what you need, say so.");
  });

  it("includes workspace declaration with working directory", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(`Your working directory is: ${workDir}`);
    expect(prompt).toContain("Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.");
  });

  it("includes workspace declaration with custom workspace directory", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const customWorkspace = "/custom/workspace/path";
    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      workspaceDir: customWorkspace,
    });

    expect(prompt).toContain(`Your working directory is: ${customWorkspace}`);
  });

  it("includes enhanced silent replies section with detailed rules", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Silent Replies");
    expect(prompt).toContain("When you have nothing to say, respond with ONLY: NO_REPLY");
    expect(prompt).toContain("⚠️ Rules:");
    expect(prompt).toContain("- It must be your ENTIRE message — nothing else");
    expect(prompt).toContain("- Never append it to an actual response");
    expect(prompt).toContain("- Never wrap it in markdown or code blocks");
  });

  it("includes enhanced heartbeats section with detailed rules", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("If you receive a heartbeat poll and there is nothing that needs attention, reply exactly:");
    expect(prompt).toContain("HEARTBEAT_OK");
    expect(prompt).toContain("OpenClaw treats a leading/trailing \"HEARTBEAT_OK\" as a heartbeat ack (and may discard it).");
    expect(prompt).toContain("If something needs attention, do NOT include \"HEARTBEAT_OK\"; reply with the alert text instead.");
  });

  it("includes expanded runtime line with agent name and repo path", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      agentName: "TestAgent",
      workspaceDir: "/test/repo",
      model: "claude-opus",
      hostname: "test-host",
      os: "linux",
      arch: "x64",
    });

    expect(prompt).toContain("## Runtime");
    expect(prompt).toContain("Runtime: agent=TestAgent");
    expect(prompt).toContain("| host=test-host");
    expect(prompt).toContain("| repo=/test/repo");
    expect(prompt).toContain("| os=linux");
    expect(prompt).toContain("(x64)");
    expect(prompt).toContain("| model=claude-opus");
  });

  it("verifies all new sections appear before Project Context", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test soul content");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      agentName: "Rook",
    });

    const projectContextIndex = prompt.indexOf("# Project Context");
    expect(projectContextIndex).toBeGreaterThan(0);

    // Verify all new sections appear before Project Context
    const identityIndex = prompt.indexOf("You are Rook, a personal assistant running on daemon-engine.");
    const toolingIndex = prompt.indexOf("## Tooling");
    const toolCallStyleIndex = prompt.indexOf("## Tool Call Style");
    const safetyIndex = prompt.indexOf("## Safety");
    const memoryRecallIndex = prompt.indexOf("## Memory Recall");
    const workspaceIndex = prompt.indexOf("## Workspace");
    const silentRepliesIndex = prompt.indexOf("## Silent Replies");
    const heartbeatsIndex = prompt.indexOf("## Heartbeats");

    expect(identityIndex).toBeLessThan(projectContextIndex);
    expect(toolingIndex).toBeLessThan(projectContextIndex);
    expect(toolCallStyleIndex).toBeLessThan(projectContextIndex);
    expect(safetyIndex).toBeLessThan(projectContextIndex);
    expect(memoryRecallIndex).toBeLessThan(projectContextIndex);
    expect(workspaceIndex).toBeLessThan(projectContextIndex);
    expect(silentRepliesIndex).toBeLessThan(projectContextIndex);
    expect(heartbeatsIndex).toBeLessThan(projectContextIndex);
  });

  it("verifies sections appear in correct order", async () => {
    await writeFile(join(workDir, "SOUL.md"), "test");
    const { buildSystemPromptWithEnv } = await import("../src/workspace.js");
    const { createNodeEnvironment } = await import("../src/env/environment.js");

    const prompt = await buildSystemPromptWithEnv(workDir, createNodeEnvironment(), {
      agentName: "Rook",
    });

    // Get indices of key sections
    const identityIndex = prompt.indexOf("You are Rook");
    const toolingIndex = prompt.indexOf("## Tooling");
    const toolCallStyleIndex = prompt.indexOf("## Tool Call Style");
    const safetyIndex = prompt.indexOf("## Safety");
    const memoryRecallIndex = prompt.indexOf("## Memory Recall");
    const workspaceIndex = prompt.indexOf("## Workspace");
    const dateTimeIndex = prompt.indexOf("## Current Date & Time");
    const runtimeIndex = prompt.indexOf("## Runtime");
    const silentRepliesIndex = prompt.indexOf("## Silent Replies");
    const heartbeatsIndex = prompt.indexOf("## Heartbeats");
    const projectContextIndex = prompt.indexOf("# Project Context");

    // Verify ordering: Identity → Tooling → Tool Call Style → Safety → Memory Recall → Workspace → Date/Time → Runtime → Silent Replies → Heartbeats → Project Context
    expect(identityIndex).toBeLessThan(toolingIndex);
    expect(toolingIndex).toBeLessThan(toolCallStyleIndex);
    expect(toolCallStyleIndex).toBeLessThan(safetyIndex);
    expect(safetyIndex).toBeLessThan(memoryRecallIndex);
    expect(memoryRecallIndex).toBeLessThan(workspaceIndex);
    expect(workspaceIndex).toBeLessThan(dateTimeIndex);
    expect(dateTimeIndex).toBeLessThan(runtimeIndex);
    expect(runtimeIndex).toBeLessThan(silentRepliesIndex);
    expect(silentRepliesIndex).toBeLessThan(heartbeatsIndex);
    expect(heartbeatsIndex).toBeLessThan(projectContextIndex);
  });
});
