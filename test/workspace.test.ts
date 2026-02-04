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
    expect(prompt).toContain("Runtime: host=");
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
});
