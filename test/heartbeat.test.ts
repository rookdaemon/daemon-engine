import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatRunner, DEFAULT_HEARTBEAT_PROMPT } from "../src/heartbeat.js";
import type { HeartbeatConfig, HeartbeatContext } from "../src/heartbeat.js";
import { buildSystemPromptWithEnv } from "../src/workspace.js";
import { callClaude } from "../src/providers/claude-cli.js";
import type { ClaudeResponse } from "../src/providers/claude-cli.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeEnvironment } from "../src/env/environment.js";

// Mock dependencies
vi.mock("../src/workspace.js", () => ({
  buildSystemPromptWithEnv: vi.fn(),
}));

vi.mock("../src/providers/claude-cli.js", () => ({
  callClaude: vi.fn(),
}));

describe("HeartbeatRunner", () => {
  const mockBuildSystemPrompt = buildSystemPromptWithEnv as unknown as ReturnType<typeof vi.fn>;
  const mockCallClaude = callClaude as unknown as ReturnType<typeof vi.fn>;

  let workDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    workDir = await mkdtemp(join(tmpdir(), "heartbeat-test-"));

    // Default mock implementations
    mockBuildSystemPrompt.mockResolvedValue("System prompt from workspace");
    mockCallClaude.mockResolvedValue({
      type: "success",
      result: "HEARTBEAT_OK",
      sessionId: "test-session",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        costUsd: 0.001,
      },
      durationMs: 100,
    } as ClaudeResponse);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(workDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("starts and stops correctly", () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      expect(runner.isRunning()).toBe(false);

      runner.start();
      expect(runner.isRunning()).toBe(true);

      runner.stop();
      expect(runner.isRunning()).toBe(false);
    });

    it("does not start if already running", () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      runner.start();
      const firstRunning = runner.isRunning();

      // Try to start again
      runner.start();
      expect(runner.isRunning()).toBe(firstRunning);

      runner.stop();
    });

    it("does not start if disabled", () => {
      const config: HeartbeatConfig = {
        enabled: false,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      runner.start();
      expect(runner.isRunning()).toBe(false);
    });
  });

  describe("timer execution", () => {
    it("fires at correct interval", async () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      // Should not have fired yet
      expect(mockCallClaude).not.toHaveBeenCalled();

      // Advance time by interval
      await vi.advanceTimersByTimeAsync(1000);

      // Should have fired once
      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      // Advance again
      await vi.advanceTimersByTimeAsync(1000);

      // Should have fired twice
      expect(mockCallClaude).toHaveBeenCalledTimes(2);

      runner.stop();
    });

    it("calls Claude with correct parameters", async () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: "Custom heartbeat prompt",
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {
          model: "sonnet",
          skipPermissions: true,
        },
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockBuildSystemPrompt).toHaveBeenCalledWith(workDir, expect.any(Object));
      expect(mockCallClaude).toHaveBeenCalledWith(
        {
          messages: [{ role: "user", content: "Custom heartbeat prompt" }],
          systemPrompt: "System prompt from workspace",
        },
        {
          model: "sonnet",
          skipPermissions: true,
        },
        expect.any(Object)
      );

      runner.stop();
    });
  });

  describe("activeHours", () => {
    it("executes when within active hours", async () => {
      // Mock current time to be 10:00 UTC
      vi.setSystemTime(new Date("2024-01-01T10:00:00Z"));

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        activeHours: [9, 17], // 9am to 5pm UTC
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      runner.stop();
    });

    it("skips when outside active hours", async () => {
      // Mock current time to be 20:00 UTC (8pm)
      vi.setSystemTime(new Date("2024-01-01T20:00:00Z"));

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        activeHours: [9, 17], // 9am to 5pm UTC
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCallClaude).not.toHaveBeenCalled();

      runner.stop();
    });

    it("handles active hours spanning midnight", async () => {
      // Mock current time to be 23:00 UTC (11pm)
      vi.setSystemTime(new Date("2024-01-01T23:00:00Z"));

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        activeHours: [22, 6], // 10pm to 6am UTC (spans midnight)
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      runner.stop();
    });

    it("handles active hours spanning midnight - early morning", async () => {
      // Mock current time to be 02:00 UTC (2am)
      vi.setSystemTime(new Date("2024-01-01T02:00:00Z"));

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        activeHours: [22, 6], // 10pm to 6am UTC (spans midnight)
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      runner.stop();
    });
  });

  describe("overlap prevention", () => {
    it("skips tick if previous execution still running", async () => {
      // Make Claude call take a long time
      let resolveCall: (() => void) | null = null;
      mockCallClaude.mockImplementation(() => {
        return new Promise<ClaudeResponse>((resolve) => {
          resolveCall = () =>
            resolve({
              type: "success",
              result: "HEARTBEAT_OK",
              sessionId: "test-session",
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                costUsd: 0.001,
              },
              durationMs: 100,
            });
        });
      });

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      // First tick starts
      vi.advanceTimersByTime(1000);
      await Promise.resolve(); // Let the tick start
      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      // Second tick should be skipped (first still running)
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(mockCallClaude).toHaveBeenCalledTimes(1); // Still 1

      // Resolve the first call
      const resolver = resolveCall as (() => void) | null;
      if (resolver) {
        resolver();
      }
      await Promise.resolve();

      // Third tick should execute now
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(mockCallClaude).toHaveBeenCalledTimes(2);

      runner.stop();
    });
  });

  describe("response handling", () => {
    it("detects HEARTBEAT_OK response", async () => {
      mockCallClaude.mockResolvedValue({
        type: "success",
        result: "HEARTBEAT_OK",
        sessionId: "test-session",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        durationMs: 100,
      } as ClaudeResponse);

      const onResponse = vi.fn();

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
        onResponse,
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(onResponse).toHaveBeenCalledWith("HEARTBEAT_OK", true);

      runner.stop();
    });

    it("detects non-HEARTBEAT_OK response", async () => {
      mockCallClaude.mockResolvedValue({
        type: "success",
        result: "I need to do something important.",
        sessionId: "test-session",
        usage: {
          inputTokens: 10,
          outputTokens: 15,
          cacheReadTokens: 0,
          costUsd: 0.002,
        },
        durationMs: 150,
      } as ClaudeResponse);

      const onResponse = vi.fn();

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
        onResponse,
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(onResponse).toHaveBeenCalledWith(
        "I need to do something important.",
        false
      );

      runner.stop();
    });

    it("handles HEARTBEAT_OK with additional text", async () => {
      mockCallClaude.mockResolvedValue({
        type: "success",
        result: "HEARTBEAT_OK - All systems nominal",
        sessionId: "test-session",
        usage: {
          inputTokens: 10,
          outputTokens: 8,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        durationMs: 120,
      } as ClaudeResponse);

      const onResponse = vi.fn();

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
        onResponse,
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      await vi.advanceTimersByTimeAsync(1000);

      expect(onResponse).toHaveBeenCalledWith(
        "HEARTBEAT_OK - All systems nominal",
        true
      );

      runner.stop();
    });

    it("works without onResponse callback", async () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 1000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
        // No onResponse callback
      };

      const runner = new HeartbeatRunner(config, context);
      runner.start();

      // Should not throw
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      runner.stop();
    });
  });

  describe("trigger", () => {
    it("executes immediately when triggered", async () => {
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 10000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      // Don't start the timer
      expect(mockCallClaude).not.toHaveBeenCalled();

      // Trigger manually
      await runner.trigger();

      expect(mockCallClaude).toHaveBeenCalledTimes(1);
    });

    it("respects active hours when triggered", async () => {
      // Mock current time to be 20:00 UTC (outside 9-17)
      vi.setSystemTime(new Date("2024-01-01T20:00:00Z"));

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 10000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
        activeHours: [9, 17],
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      await runner.trigger();

      // Should not execute outside active hours
      expect(mockCallClaude).not.toHaveBeenCalled();
    });

    it("respects overlap prevention when triggered", async () => {
      // Make Claude call take a long time
      let resolveCall: (() => void) | null = null;
      mockCallClaude.mockImplementation(() => {
        return new Promise<ClaudeResponse>((resolve) => {
          resolveCall = () =>
            resolve({
              type: "success",
              result: "HEARTBEAT_OK",
              sessionId: "test-session",
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                costUsd: 0.001,
              },
              durationMs: 100,
            });
        });
      });

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMs: 10000,
        prompt: DEFAULT_HEARTBEAT_PROMPT,
      };

      const context: HeartbeatContext = {
        workspaceDir: workDir,
        claudeConfig: {},
        env: createNodeEnvironment(),
      };

      const runner = new HeartbeatRunner(config, context);

      // First trigger
      const trigger1 = runner.trigger();
      await Promise.resolve(); // Let it start
      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      // Second trigger while first is running
      const trigger2 = runner.trigger();
      await Promise.resolve();
      
      // Should still be only 1 call (overlap prevented)
      expect(mockCallClaude).toHaveBeenCalledTimes(1);

      // Resolve both
      const resolver = resolveCall as (() => void) | null;
      if (resolver) {
        resolver();
      }
      await trigger1;
      await trigger2;
    });
  });

  describe("default prompt", () => {
    it("exports default heartbeat prompt", () => {
      expect(DEFAULT_HEARTBEAT_PROMPT).toBe(
        "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."
      );
    });
  });
});
