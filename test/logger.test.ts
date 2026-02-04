import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initLogger, resetLogger, log } from "../src/logger.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("logger", () => {
  let testDir: string;
  let logFile: string;
  const env = createNodeEnvironment();

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-logger-test-"));
    logFile = join(testDir, "test.log");
    resetLogger();
  });

  afterEach(async () => {
    resetLogger();
    await rm(testDir, { recursive: true, force: true });
  });

  it("formats log lines with ISO 8601 timestamps", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Use a fixed-time environment
    const fixedEnv = { ...env, clock: { now: () => 1706972400000 } }; // 2024-02-03T15:00:00.000Z
    initLogger(logFile, fixedEnv);

    log.info("[test]", "hello world");

    expect(logSpy).toHaveBeenCalledWith(
      "2024-02-03T15:00:00.000Z INFO [test] hello world"
    );

    logSpy.mockRestore();
  });

  it("writes info to log file", async () => {
    initLogger(logFile, env);

    log.info("[test]", "file output test");

    // Wait for fire-and-forget write
    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logFile, "utf-8");
    expect(content).toContain("INFO [test] file output test");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes error to log file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    initLogger(logFile, env);

    log.error("[test]", "something broke");

    // Wait for fire-and-forget write
    await new Promise((r) => setTimeout(r, 100));

    const content = await readFile(logFile, "utf-8");
    expect(content).toContain("ERROR [test] something broke");

    errorSpy.mockRestore();
  });

  it("appends multiple log lines", async () => {
    initLogger(logFile, env);

    log.info("[test]", "line one");
    log.info("[test]", "line two");

    await new Promise((r) => setTimeout(r, 200));

    const content = await readFile(logFile, "utf-8");
    const lines = content.trim().split("\n");
    // initLogger writes an initial "Logging to ..." line, then our two lines
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("Logging to");
    expect(lines[1]).toContain("line one");
    expect(lines[2]).toContain("line two");
  });

  it("works without initialization (console only)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // No initLogger call — should still write to console
    log.info("[test]", "console only");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("INFO [test] console only")
    );

    logSpy.mockRestore();
  });

  it("rotates log file when size threshold is exceeded", async () => {
    initLogger(logFile, env);

    // Write enough data to exceed 5 MB
    const bigMessage = "x".repeat(100_000);
    for (let i = 0; i < 55; i++) {
      log.info("[test]", bigMessage);
    }

    // Wait for all async writes + rotation
    await new Promise((r) => setTimeout(r, 2000));

    // The rotated file should exist
    const rotatedContent = await readFile(`${logFile}.1`, "utf-8").catch(() => "");
    expect(rotatedContent.length).toBeGreaterThan(0);

    // The active log file should have been truncated and have new content
    const activeContent = await readFile(logFile, "utf-8");
    expect(activeContent.length).toBeLessThan(5 * 1024 * 1024 + 200_000);
  });
});
