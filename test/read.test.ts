import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { read } from "../src/tools/read.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { ToolContext } from "../src/agent.js";

describe("read tool", () => {
  let workDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "daemon-engine-read-test-"));
    context = {
      workspace: workDir,
      env: createNodeEnvironment(),
      sessionKey: "test-session",
      config: {
        workspace: workDir,
        model: { provider: "anthropic", name: "test", apiKey: "test" },
        server: { port: 3000 },
      },
    };
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reads file contents", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "Hello, world!");

    const result = await read.execute({ path: filePath }, context);

    expect(result).toBe("Hello, world!");
  });

  it("lists directory entries", async () => {
    await mkdir(join(workDir, "subdir"));
    await writeFile(join(workDir, "file1.txt"), "content1");
    await writeFile(join(workDir, "file2.txt"), "content2");

    const result = await read.execute({ path: workDir }, context);

    expect(result).toContain("subdir");
    expect(result).toContain("file1.txt");
    expect(result).toContain("file2.txt");
  });

  it("throws on non-existent path", async () => {
    const fakePath = join(workDir, "does-not-exist.txt");

    await expect(read.execute({ path: fakePath }, context)).rejects.toThrow();
  });

  it("has correct description and parameters", () => {
    expect(read.description).toBeTruthy();
    expect(read.parameters.type).toBe("object");
    expect(read.parameters.properties.path).toBeTruthy();
    expect(read.parameters.required).toContain("path");
  });
});
