/**
 * observability.ts — Structured logging and monitoring for external observability.
 *
 * This module provides a centralized log collection system for diagnostic visibility
 * and external monitoring. Logs are stored in memory with a circular buffer.
 */

/**
 * Structured log entry.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: "info" | "error" | "warning";
  /** Log category/component */
  category: string;
  /** Log message */
  message: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
}

/**
 * Workspace file load event.
 */
export interface WorkspaceLoadEvent {
  /** File path relative to workspace */
  file: string;
  /** File size in bytes */
  bytes: number;
  /** Whether load was successful */
  success: boolean;
  /** Error message if load failed */
  error?: string;
}

/**
 * Tool invocation event.
 */
export interface ToolInvocationEvent {
  /** Tool name */
  name: string;
  /** Whether tool call succeeded */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Error message if tool call failed */
  error?: string;
}

/**
 * Model API call event.
 */
export interface ModelApiCallEvent {
  /** Model name */
  model: string;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cache read tokens */
  cacheReadTokens: number;
  /** Cost in USD */
  costUsd: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Session ID */
  sessionId?: string;
}

/**
 * Observability collector for logs and events.
 */
export class ObservabilityCollector {
  private logs: LogEntry[] = [];
  private readonly maxLogs: number;

  constructor(maxLogs: number = 1000) {
    this.maxLogs = maxLogs;
  }

  /**
   * Add a log entry to the collection.
   */
  addLog(entry: LogEntry): void {
    this.logs.push(entry);
    
    // Maintain circular buffer by removing oldest entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * Log an info message.
   * @param now - Optional timestamp in ms (caller passes env.clock.now() for testability)
   */
  info(category: string, message: string, data?: Record<string, unknown>, now?: number): void {
    this.addLog({
      timestamp: new Date(now ?? Date.now()).toISOString(),
      level: "info",
      category,
      message,
      data,
    });
  }

  /**
   * Log an error message.
   * @param now - Optional timestamp in ms (caller passes env.clock.now() for testability)
   */
  error(category: string, message: string, data?: Record<string, unknown>, now?: number): void {
    this.addLog({
      timestamp: new Date(now ?? Date.now()).toISOString(),
      level: "error",
      category,
      message,
      data,
    });
  }

  /**
   * Log a warning message.
   * @param now - Optional timestamp in ms (caller passes env.clock.now() for testability)
   */
  warning(category: string, message: string, data?: Record<string, unknown>, now?: number): void {
    this.addLog({
      timestamp: new Date(now ?? Date.now()).toISOString(),
      level: "warning",
      category,
      message,
      data,
    });
  }

  /**
   * Log a workspace file load event.
   */
  logWorkspaceLoad(event: WorkspaceLoadEvent): void {
    this.info("workspace", `Loaded ${event.file} (${event.bytes} bytes)`, {
      file: event.file,
      bytes: event.bytes,
      success: event.success,
      error: event.error,
    });
  }

  /**
   * Log a tool invocation event.
   */
  logToolInvocation(event: ToolInvocationEvent): void {
    if (event.success) {
      this.info("tool", `Tool ${event.name} executed successfully (${event.durationMs}ms)`, {
        name: event.name,
        success: event.success,
        durationMs: event.durationMs,
      });
    } else {
      this.error("tool", `Tool ${event.name} failed: ${event.error || "Unknown error"}`, {
        name: event.name,
        success: event.success,
        durationMs: event.durationMs,
        error: event.error,
      });
    }
  }

  /**
   * Log a model API call event.
   */
  logModelApiCall(event: ModelApiCallEvent): void {
    this.info("model", `API call to ${event.model} (${event.durationMs}ms, ${event.inputTokens}+${event.outputTokens} tokens, $${event.costUsd.toFixed(4)})`, {
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      costUsd: event.costUsd,
      durationMs: event.durationMs,
      sessionId: event.sessionId,
    });
  }

  /**
   * Get the last N log entries.
   */
  getLogs(limit: number = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  /**
   * Get all logs.
   */
  getAllLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Clear all logs.
   */
  clearLogs(): void {
    this.logs = [];
  }
}

/**
 * Global observability collector instance.
 */
export const observability = new ObservabilityCollector();
