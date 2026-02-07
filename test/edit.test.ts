import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { edit } from "../src/tools/edit.js";
import { createTestContext } from "./fakes/test-context.js";
import type { ToolContext } from "../src/agent.js";

describe("edit tool", () => {
  let workDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "daemon-engine-edit-test-"));
    context = createTestContext(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("replaces a unique string in a file", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "Hello, world! This is a test.");

    const result = await edit.execute(
      {
        path: filePath,
        old_string: "world",
        new_string: "universe",
      },
      context
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("Hello, universe! This is a test.");
    expect(result).toContain("test.txt");
    expect(result).toContain("replaced 1 occurrence(s)");
  });

  it("throws when old_string not found", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "Hello, world!");

    await expect(
      edit.execute(
        {
          path: filePath,
          old_string: "missing",
          new_string: "replacement",
        },
        context
      )
    ).rejects.toThrow("old_string not found in");
  });

  it("throws when old_string is not unique and replace_all is false", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "foo bar foo baz foo");

    await expect(
      edit.execute(
        {
          path: filePath,
          old_string: "foo",
          new_string: "qux",
        },
        context
      )
    ).rejects.toThrow("old_string is not unique");
    
    await expect(
      edit.execute(
        {
          path: filePath,
          old_string: "foo",
          new_string: "qux",
        },
        context
      )
    ).rejects.toThrow("found 3 occurrences");
  });

  it("replaces all occurrences when replace_all is true", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "foo bar foo baz foo");

    const result = await edit.execute(
      {
        path: filePath,
        old_string: "foo",
        new_string: "qux",
        replace_all: true,
      },
      context
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("qux bar qux baz qux");
    expect(result).toContain("replaced 3 occurrence(s)");
  });

  it("throws when old_string and new_string are identical", async () => {
    const filePath = join(workDir, "test.txt");
    await writeFile(filePath, "Hello, world!");

    await expect(
      edit.execute(
        {
          path: filePath,
          old_string: "world",
          new_string: "world",
        },
        context
      )
    ).rejects.toThrow("old_string and new_string are identical");
  });

  it("handles empty file gracefully", async () => {
    const filePath = join(workDir, "empty.txt");
    await writeFile(filePath, "");

    await expect(
      edit.execute(
        {
          path: filePath,
          old_string: "something",
          new_string: "else",
        },
        context
      )
    ).rejects.toThrow("old_string not found in");
  });

  it("handles multiline strings", async () => {
    const filePath = join(workDir, "multiline.txt");
    const originalContent = `Line 1
Line 2
Line 3`;
    await writeFile(filePath, originalContent);

    const result = await edit.execute(
      {
        path: filePath,
        old_string: "Line 2",
        new_string: "Modified Line 2",
      },
      context
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(`Line 1
Modified Line 2
Line 3`);
    expect(result).toContain("replaced 1 occurrence(s)");
  });

  it("handles special characters in strings", async () => {
    const filePath = join(workDir, "special.txt");
    await writeFile(filePath, 'const x = "hello";');

    const result = await edit.execute(
      {
        path: filePath,
        old_string: '"hello"',
        new_string: '"goodbye"',
      },
      context
    );

    const content = await readFile(filePath, "utf-8");
    expect(content).toBe('const x = "goodbye";');
    expect(result).toContain("replaced 1 occurrence(s)");
  });

  it("throws on non-existent file", async () => {
    const fakePath = join(workDir, "does-not-exist.txt");

    await expect(
      edit.execute(
        {
          path: fakePath,
          old_string: "foo",
          new_string: "bar",
        },
        context
      )
    ).rejects.toThrow();
  });

  it("has correct description and parameters", () => {
    expect(edit.description).toBeTruthy();
    expect(edit.parameters.type).toBe("object");
    expect(edit.parameters.properties.path).toBeTruthy();
    expect(edit.parameters.properties.old_string).toBeTruthy();
    expect(edit.parameters.properties.new_string).toBeTruthy();
    expect(edit.parameters.properties.replace_all).toBeTruthy();
    expect(edit.parameters.required).toContain("path");
    expect(edit.parameters.required).toContain("old_string");
    expect(edit.parameters.required).toContain("new_string");
    expect(edit.parameters.required).not.toContain("replace_all");
  });
});
