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

  it("skips missing files gracefully", async () => {
    await writeFile(join(workDir, "SOUL.md"), "Just a soul.");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("Just a soul.");
    expect(prompt).not.toContain("MEMORY.md");
  });

  it("returns empty string for empty workspace", async () => {
    const prompt = await buildSystemPrompt(workDir);
    expect(prompt).toBe("");
  });

  it("exports the list of workspace files", () => {
    expect(WORKSPACE_FILES).toEqual([
      "SOUL.md",
      "AGENTS.md",
      "USER.md",
      "MEMORY.md",
      "TOOLS.md",
      "HEARTBEAT.md",
    ]);
  });

  it("trims whitespace from file contents", async () => {
    await writeFile(join(workDir, "SOUL.md"), "  padded content  \n\n");

    const prompt = await buildSystemPrompt(workDir);

    expect(prompt).toContain("padded content");
    expect(prompt).not.toMatch(/  padded/);
  });
});
