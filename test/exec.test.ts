import { describe, it, expect } from "vitest";
import { exec } from "../src/tools/exec.js";

describe("exec tool", () => {
  it("executes a simple command", async () => {
    const result = await exec.execute({
      command: "echo",
      args: ["hello"],
    });

    expect(result).toContain("hello");
  });

  it("uses working directory", async () => {
    const result = await exec.execute({
      command: "pwd",
      cwd: "/tmp",
    });

    expect(result.trim()).toBe("/tmp");
  });

  it("includes stderr in output", async () => {
    // Use a command that writes to stderr
    const result = await exec.execute({
      command: "sh",
      args: ["-c", "echo error >&2"],
    });

    expect(result).toContain("error");
    expect(result).toContain("[stderr]");
  });

  it("throws on command failure", async () => {
    await expect(
      exec.execute({
        command: "false", // Always exits with code 1
      })
    ).rejects.toThrow();
  });

  it("throws on timeout", async () => {
    await expect(
      exec.execute({
        command: "sleep",
        args: ["10"],
        timeout: 100, // 100ms timeout
      })
    ).rejects.toThrow();
  });

  it("throws on non-existent command", async () => {
    await expect(
      exec.execute({
        command: "this-command-does-not-exist-xyz123",
      })
    ).rejects.toThrow();
  });

  it("uses default timeout", async () => {
    // Should complete within default 30s timeout
    const result = await exec.execute({
      command: "echo",
      args: ["quick"],
    });

    expect(result).toContain("quick");
  });

  it("has correct description and parameters", () => {
    expect(exec.description).toBeTruthy();
    expect(exec.parameters.type).toBe("object");
    expect(exec.parameters.properties.command).toBeTruthy();
    expect(exec.parameters.properties.args).toBeTruthy();
    expect(exec.parameters.properties.cwd).toBeTruthy();
    expect(exec.parameters.properties.timeout).toBeTruthy();
    expect(exec.parameters.required).toContain("command");
  });
});
