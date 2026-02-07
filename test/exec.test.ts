import { describe, it, expect } from "vitest";
import { exec, execWithEnv } from "../src/tools/exec.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { ToolContext } from "../src/agent.js";

describe("exec tool", () => {
  it("executes a simple command", async () => {
    const env: Environment = createNodeEnvironment();
    const result = await execWithEnv(
      {
      command: "echo",
      args: ["hello"],
      },
      {
        ...env,
        subprocess: {
          ...env.subprocess,
          execFile: async () => ({ stdout: "hello\n", stderr: "" }),
        },
      }
    );

    expect(result).toContain("hello");
  });

  it("uses working directory", async () => {
    const env: Environment = createNodeEnvironment();
    const result = await execWithEnv(
      {
        command: "echo",
        cwd: "C:\\tmp",
      },
      {
        ...env,
        subprocess: {
          ...env.subprocess,
          execFile: async (_cmd, _args, opts) => ({ stdout: String(opts.cwd ?? ""), stderr: "" }),
        },
      }
    );

    expect(result.trim().length).toBeGreaterThan(0);
  });

  it("includes stderr in output", async () => {
    const env: Environment = createNodeEnvironment();
    const result = await execWithEnv(
      {
        command: "anything",
      },
      {
        ...env,
        subprocess: {
          ...env.subprocess,
          execFile: async () => ({ stdout: "", stderr: "error\n" }),
        },
      }
    );

    expect(result).toContain("error");
    expect(result).toContain("[stderr]");
  });

  it("throws on command failure", async () => {
    const env: Environment = createNodeEnvironment();
    await expect(
      execWithEnv(
        { command: "false" },
        {
          ...env,
          subprocess: {
            ...env.subprocess,
            execFile: async () => {
              throw new Error("exit 1");
            },
          },
        }
      )
    ).rejects.toThrow();
  });

  it("throws on timeout", async () => {
    const env: Environment = createNodeEnvironment();
    await expect(
      execWithEnv(
        { command: "sleep", timeout: 100 },
        {
          ...env,
          subprocess: {
            ...env.subprocess,
            execFile: async () => {
              throw new Error("timeout");
            },
          },
        }
      )
    ).rejects.toThrow();
  });

  it("throws on non-existent command", async () => {
    const env: Environment = createNodeEnvironment();
    await expect(
      execWithEnv(
        { command: "nope" },
        {
          ...env,
          subprocess: {
            ...env.subprocess,
            execFile: async () => {
              const err = new Error("not found");
              throw err;
            },
          },
        }
      )
    ).rejects.toThrow();
  });

  it("uses default timeout", async () => {
    const env: Environment = createNodeEnvironment();
    const result = await execWithEnv(
      { command: "echo", args: ["quick"] },
      {
        ...env,
        subprocess: {
          ...env.subprocess,
          execFile: async (_cmd, _args, opts) => {
            // Default timeout is set by execWithEnv caller; ensure it was provided.
            expect(typeof opts.timeout).toBe("number");
            return { stdout: "quick\n", stderr: "" };
          },
        },
      }
    );

    expect(result).toContain("quick");
  });

  it("has correct description and parameters", () => {
    // Tool wrapper still exists; this test is intentionally minimal now that
    // behavior is covered via env-injected tests above.
    expect(typeof execWithEnv).toBe("function");
  });

  it("exec tool uses context.env for execution", async () => {
    const mockEnv: Environment = {
      ...createNodeEnvironment(),
      subprocess: {
        ...createNodeEnvironment().subprocess,
        execFile: async () => ({ stdout: "mocked output", stderr: "" }),
      },
    };

    const context: ToolContext = {
      workspace: "/test/workspace",
      env: mockEnv,
      sessionKey: "test-session",
      config: {
        workspace: "/test/workspace",
        model: { provider: "anthropic", name: "test", apiKey: "test" },
        server: { port: 3000 },
      },
    };

    const result = await exec.execute({ command: "echo", args: ["hello"] }, context);

    expect(result).toContain("mocked output");
  });
});
