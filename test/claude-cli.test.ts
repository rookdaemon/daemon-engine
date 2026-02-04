import { describe, it, expect, vi, beforeEach } from "vitest";
import { callClaude } from "../src/providers/claude-cli.js";
import type { ClaudeRequest, ClaudeCliConfig } from "../src/providers/claude-cli.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { Environment } from "../src/env/environment.js";

describe("callClaude", () => {
  const mockSpawn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to create a mock child process with expected behavior.
   */
  function createMockChildProcess(options: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: Error;
    delay?: number;
  }): Partial<ChildProcess> & EventEmitter {
    const child = new EventEmitter();
    const mockChild = child as Partial<ChildProcess> & EventEmitter;
    mockChild.stdout = new EventEmitter() as ChildProcess["stdout"];
    mockChild.stderr = new EventEmitter() as ChildProcess["stderr"];
    mockChild.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ChildProcess["stdin"];
    mockChild.kill = vi.fn();

    // Simulate process behavior
    setTimeout(() => {
      if (options.error) {
        mockChild.emit("error", options.error);
      } else {
        if (options.stdout && mockChild.stdout) {
          mockChild.stdout.emit("data", Buffer.from(options.stdout));
        }
        if (options.stderr && mockChild.stderr) {
          mockChild.stderr.emit("data", Buffer.from(options.stderr));
        }
        mockChild.emit("exit", options.exitCode ?? 0);
      }
    }, options.delay ?? 10);

    return mockChild;
  }

  it("calls claude with correct arguments for basic request", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Hello, world!",
        session_id: "test-session-123",
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 2,
        },
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Say hello",
      systemPrompt: "You are a helpful assistant.",
    };

    const config: ClaudeCliConfig = {
      model: "sonnet",
      skipPermissions: true,
    };

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    // Verify spawn was called with correct arguments
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--system-prompt",
        "You are a helpful assistant.",
        "--model",
        "sonnet",
        "--dangerously-skip-permissions",
      ],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
      })
    );

    // Verify prompt was written to stdin
    expect(mockChild.stdin).toBeDefined();
    expect((mockChild.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledWith("Say hello");
    expect((mockChild.stdin as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled();

    // Verify response
    expect(response.type).toBe("success");
    expect(response.result).toBe("Hello, world!");
    expect(response.sessionId).toBe("test-session-123");
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.usage.cacheReadTokens).toBe(2);
    expect(response.usage.costUsd).toBe(0.01);
    expect(response.durationMs).toBeGreaterThan(0);
  });

  it("includes tools argument when tools are specified", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "session-456",
        total_cost_usd: 0.005,
        usage: {},
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test prompt",
      systemPrompt: "System prompt",
    };

    const config: ClaudeCliConfig = {
      tools: ["Bash", "Read", "Write"],
    };

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    await callClaude(request, config, env);

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--tools", "Bash,Read,Write"]),
      expect.any(Object)
    );
  });

  it("includes continue argument for session continuation", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Continued response",
        session_id: "session-789",
        total_cost_usd: 0.002,
        usage: {},
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Continue from here",
      systemPrompt: "System",
      continueSession: "previous-session-id",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    await callClaude(request, config, env);

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--continue", "previous-session-id"]),
      expect.any(Object)
    );
    
    // Verify that --system-prompt is NOT included when continuing session
    const callArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain("--system-prompt");
  });

  it("uses working directory when specified", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Response",
        session_id: "session-cwd",
        total_cost_usd: 0,
        usage: {},
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {
      workingDir: "/custom/path",
    };

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    await callClaude(request, config, env);

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({
        cwd: "/custom/path",
      })
    );
  });

  it("handles timeout correctly", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Should not complete",
        session_id: "timeout-session",
        total_cost_usd: 0,
        usage: {},
      }),
      delay: 500, // Longer than timeout
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Slow operation",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {
      timeout: 100, // 100ms timeout
    };

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    expect(response.type).toBe("error");
    expect(response.result).toContain("timeout");
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("handles non-zero exit code", async () => {
    const mockChild = createMockChildProcess({
      stdout: "Some output",
      stderr: "Error message",
      exitCode: 1,
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    expect(response.type).toBe("error");
    expect(response.result).toContain("exited with code 1");
    expect(response.result).toContain("Error message");
  });

  it("handles spawn error", async () => {
    const mockChild = createMockChildProcess({
      error: new Error("Command not found"),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    expect(response.type).toBe("error");
    expect(response.result).toContain("Failed to spawn Claude CLI");
    expect(response.result).toContain("Command not found");
  });

  it("handles JSON parse error", async () => {
    const mockChild = createMockChildProcess({
      stdout: "Invalid JSON {{{",
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    expect(response.type).toBe("error");
    expect(response.result).toContain("Failed to parse Claude CLI response");
    expect(response.result).toContain("Invalid JSON");
  });

  it("handles error subtype in response", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "error",
        result: "Something went wrong",
        session_id: "error-session",
        total_cost_usd: 0,
        usage: {},
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    expect(response.type).toBe("error");
    expect(response.result).toBe("Something went wrong");
  });

  it("handles missing fields in JSON response gracefully", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        // Missing most fields
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    const response = await callClaude(request, config, env);

    // Should not throw, should provide defaults
    expect(response.result).toBe("");
    expect(response.sessionId).toBe("");
    expect(response.usage.inputTokens).toBe(0);
    expect(response.usage.outputTokens).toBe(0);
    expect(response.usage.cacheReadTokens).toBe(0);
    expect(response.usage.costUsd).toBe(0);
  });

  it("does not include optional flags when not specified", async () => {
    const mockChild = createMockChildProcess({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Response",
        session_id: "minimal-session",
        total_cost_usd: 0,
        usage: {},
      }),
    });

    mockSpawn.mockReturnValue(mockChild);

    const request: ClaudeRequest = {
      prompt: "Test",
      systemPrompt: "System",
    };

    const config: ClaudeCliConfig = {};

    const baseEnv = createNodeEnvironment();
    const env: Environment = {
      ...baseEnv,
      subprocess: {
        ...baseEnv.subprocess,
        spawn: (cmd, args, opts) => mockSpawn(cmd, args, opts) as unknown as ChildProcess,
      },
    };

    await callClaude(request, config, env);

    const callArgs = mockSpawn.mock.calls[0][1] as string[];

    // Should not include these optional flags
    expect(callArgs).not.toContain("--model");
    expect(callArgs).not.toContain("--dangerously-skip-permissions");
    expect(callArgs).not.toContain("--tools");
    expect(callArgs).not.toContain("--continue");

    // Should always include these
    expect(callArgs).toContain("-p");
    expect(callArgs).toContain("--output-format");
    expect(callArgs).toContain("json");
    expect(callArgs).toContain("--system-prompt");
  });
});
