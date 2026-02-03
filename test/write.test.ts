import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { write } from "../src/tools/write.js";

describe("write tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "daemon-engine-write-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates a new file", async () => {
    const filePath = join(workDir, "newfile.txt");
    const content = "This is new content.";

    const result = await write.execute({ path: filePath, content });

    const written = await readFile(filePath, "utf-8");
    expect(written).toBe(content);
    expect(result).toContain("newfile.txt");
  });

  it("overwrites an existing file", async () => {
    const filePath = join(workDir, "existing.txt");
    
    // Create initial file
    const result1 = await write.execute({
      path: filePath,
      content: "original content",
    });
    expect(result1).toContain("existing.txt");

    // Overwrite it
    const result2 = await write.execute({
      path: filePath,
      content: "new content",
    });

    const written = await readFile(filePath, "utf-8");
    expect(written).toBe("new content");
    expect(result2).toContain("existing.txt");
  });

  it("creates parent directories if needed", async () => {
    const filePath = join(workDir, "nested", "deep", "file.txt");
    const content = "nested file content";

    await write.execute({ path: filePath, content });

    const written = await readFile(filePath, "utf-8");
    expect(written).toBe(content);

    // Verify parent directories were created
    await access(join(workDir, "nested"));
    await access(join(workDir, "nested", "deep"));
  });

  it("reports bytes written", async () => {
    const filePath = join(workDir, "bytes.txt");
    const content = "12345";

    const result = await write.execute({ path: filePath, content });

    expect(result).toContain("5 bytes");
  });

  it("has correct description and parameters", () => {
    expect(write.description).toBeTruthy();
    expect(write.parameters.type).toBe("object");
    expect(write.parameters.properties.path).toBeTruthy();
    expect(write.parameters.properties.content).toBeTruthy();
    expect(write.parameters.required).toContain("path");
    expect(write.parameters.required).toContain("content");
  });
});
