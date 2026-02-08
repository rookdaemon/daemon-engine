/**
 * heartbeat.ts — Heartbeat runner for proactive agent operation.
 *
 * Periodically invokes the Claude CLI provider with a heartbeat prompt,
 * allowing the agent to check HEARTBEAT.md and perform scheduled tasks.
 * Supports configurable intervals, active hours, and overlap prevention.
 */

import { buildSystemPromptWithEnv } from "./workspace.js";
import { callClaude } from "./providers/claude-cli.js";
import type { ClaudeCliConfig } from "./providers/claude-cli.js";
import type { Environment } from "./env/environment.js";

/**
 * Configuration for heartbeat execution.
 */
export interface HeartbeatConfig {
  /** Whether heartbeat is enabled. */
  enabled: boolean;
  /** Interval between heartbeats in milliseconds. */
  intervalMs: number;
  /** Prompt to send on each heartbeat. */
  prompt: string;
  /** Optional active hours window [startHour, endHour] in UTC (0-23). */
  activeHours?: [number, number];
}

/**
 * Context for heartbeat execution.
 */
export interface HeartbeatContext {
  /** Workspace directory path for loading context files. */
  workspaceDir: string;
  /** Claude CLI configuration. */
  claudeConfig: ClaudeCliConfig;
  /** Optional callback invoked after each heartbeat response. */
  onResponse?: (response: string, isHeartbeatOk: boolean) => void;

  /** Environment abstraction (fs, subprocess, clock, etc.) */
  env: Environment;
}

/**
 * Default heartbeat prompt.
 */
export const DEFAULT_HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

/**
 * Heartbeat runner that periodically invokes Claude CLI.
 *
 * The runner:
 * - Fires at configured intervals
 * - Checks active hours window (if configured)
 * - Loads workspace context and calls Claude CLI
 * - Detects HEARTBEAT_OK responses
 * - Prevents overlapping executions
 * - Invokes callback with results
 */
export class HeartbeatRunner {
  private config: HeartbeatConfig;
  private context: HeartbeatContext;
  private timerId: NodeJS.Timeout | null = null;
  private isExecuting = false;

  constructor(config: HeartbeatConfig, context: HeartbeatContext) {
    this.config = config;
    this.context = context;
  }

  /**
   * Start the heartbeat timer.
   * Does nothing if already running.
   */
  start(): void {
    if (this.timerId !== null) {
      return; // Already running
    }

    if (!this.config.enabled) {
      return; // Disabled
    }

    // Set up periodic timer
    this.timerId = this.context.env.process.setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);
  }

  /**
   * Stop the heartbeat timer.
   */
  stop(): void {
    if (this.timerId !== null) {
      this.context.env.process.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Check if the heartbeat timer is running.
   */
  isRunning(): boolean {
    return this.timerId !== null;
  }

  /**
   * Trigger an immediate heartbeat execution (for testing).
   * Respects active hours and overlap prevention.
   */
  async trigger(): Promise<void> {
    await this.tick();
  }

  /**
   * Internal tick handler: executes heartbeat if conditions are met.
   */
  private async tick(): Promise<void> {
    // Check active hours
    if (!this.isInActiveHours()) {
      return;
    }

    // Prevent overlap
    if (this.isExecuting) {
      return;
    }

    this.isExecuting = true;

    try {
      // Load workspace context
      const env = this.context.env;
      const systemPrompt = await buildSystemPromptWithEnv(this.context.workspaceDir, env);

      // Call Claude CLI with heartbeat prompt
      const response = await callClaude(
        {
          messages: [{ role: "user", content: this.config.prompt }],
          systemPrompt,
        },
        this.context.claudeConfig,
        env
      );

      // Check if response indicates HEARTBEAT_OK
      const isHeartbeatOk = response.result.trim().startsWith("HEARTBEAT_OK");

      // Invoke callback if provided
      if (this.context.onResponse) {
        this.context.onResponse(response.result, isHeartbeatOk);
      }
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Check if current time is within active hours window.
   * Returns true if no active hours configured.
   */
  private isInActiveHours(): boolean {
    if (!this.config.activeHours) {
      return true; // No restriction
    }

    const [startHour, endHour] = this.config.activeHours;
    const currentHour = new Date(this.context.env.clock.now()).getUTCHours();

    // Handle cases where window spans midnight
    if (startHour <= endHour) {
      // Normal range: e.g., 9-17 (9am to 5pm)
      return currentHour >= startHour && currentHour < endHour;
    } else {
      // Wraps midnight: e.g., 22-6 (10pm to 6am)
      return currentHour >= startHour || currentHour < endHour;
    }
  }
}
