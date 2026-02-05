/**
 * claude-cli.ts — Claude CLI subprocess wrapper for model inference.
 *
 * Spawns Claude Code CLI (`claude -p`) as a subprocess to leverage
 * Claude Max subscription programmatically. Provides typed interface
 * for configuration, requests, and responses.
 */

import type { Environment } from "../env/environment.js";
import { createNodeEnvironment } from "../env/environment.js";
import { log } from "../logger.js";
import { observability } from "../observability.js";

/**
 * Configuration for Claude CLI execution.
 */
export interface ClaudeCliConfig {
  /** Model name: "opus", "sonnet", or full model identifier. */
  model?: string;
  /** Available tools: e.g., ["Bash", "Read", "Write", "Edit"]. Defaults to all. */
  tools?: string[];
  /** Skip permission prompts with --dangerously-skip-permissions. */
  skipPermissions?: boolean;
  /** Timeout in milliseconds. Kills subprocess if exceeded. */
  timeout?: number;
  /** Working directory for the claude process. */
  workingDir?: string;
}

/**
 * Request structure for Claude CLI invocation.
 */
export interface ClaudeRequest {
  /** The user prompt to send to Claude. */
  prompt: string;
  /** System prompt to configure behavior. */
  systemPrompt: string;
  /** Session ID to continue from (enables --continue flag). */
  continueSession?: string;
}

/**
 * Response structure from Claude CLI.
 */
export interface ClaudeResponse {
  /** Result type: "success" or "error". */
  type: "success" | "error";
  /** The assistant's response text or error message. */
  result: string;
  /** CLI session ID for continuation. */
  sessionId: string;
  /** Token usage and cost information. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  /** Execution duration in milliseconds. */
  durationMs: number;
}

/**
 * Stream event types from Claude CLI.
 */
export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }; durationMs: number };

/**
 * Callback for handling stream events.
 */
export type StreamCallback = (event: StreamEvent) => void | Promise<void>;

/**
 * Call Claude CLI with a prompt and configuration.
 *
 * Spawns `claude` subprocess with appropriate flags, sends prompt via stdin,
 * collects JSON output, and returns parsed response.
 *
 * @param request - The prompt and system prompt to send
 * @param config - Configuration for Claude CLI execution
 * @returns Parsed response with result, session ID, and usage stats
 */
export async function callClaude(
  request: ClaudeRequest,
  config: ClaudeCliConfig,
  env: Environment = createNodeEnvironment()
): Promise<ClaudeResponse> {
  const startTime = env.clock.now();

  // Build command arguments
  const args = [
    "-p", // Print mode
    "--output-format",
    "json",
  ];

  // Only include system prompt for new sessions (not when continuing)
  if (!request.continueSession) {
    args.push("--system-prompt", request.systemPrompt);
  }

  // Add optional arguments
  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (config.tools && config.tools.length > 0) {
    args.push("--tools", config.tools.join(","));
  }

  // Add continue flag for session continuation
  if (request.continueSession) {
    args.push("--continue", request.continueSession);
  }

  // Log the request
  const session = request.continueSession ? `continue:${request.continueSession}` : "new";
  log.info("[claude-cli]", `Request [session=${session}, model=${config.model || "default"}]: ${request.prompt}`);

  // Spawn subprocess
  const child = env.subprocess.spawn("claude", args, {
    cwd: config.workingDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Set up timeout if specified
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    if (config.timeout) {
      timeoutId = env.process.setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Claude CLI timeout after ${config.timeout}ms`));
      }, config.timeout);
    }
  });

  // Collect stdout and stderr
  let stdout = "";
  let stderr = "";

  if (!child.stdout || !child.stderr || !child.stdin) {
    return {
      type: "error",
      result: "Claude CLI stdio not available (expected piped stdio).",
      sessionId: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      },
      durationMs: env.clock.now() - startTime,
    };
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // Write prompt to stdin and close it
  child.stdin.write(request.prompt);
  child.stdin.end();

  // Wait for process to complete or timeout
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    child.on("exit", (code) => {
      resolve(code);
    });
  });

  try {
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);

    // Clear timeout if it was set
    if (timeoutId) {
      env.process.clearTimeout(timeoutId);
    }

    const durationMs = env.clock.now() - startTime;

    // Log full Claude CLI output for inspection
    if (stderr) {
      log.info("[claude-cli]", `stderr:\n${stderr}`);
    }
    log.info("[claude-cli]", `stdout:\n${stdout}`);

    // Handle non-zero exit code
    if (exitCode !== 0) {
      return {
        type: "error",
        result: `Claude CLI exited with code ${exitCode}\nStderr: ${stderr}\nStdout: ${stdout}`,
        sessionId: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        },
        durationMs,
      };
    }

    // Parse JSON response
    try {
      const response = JSON.parse(stdout);

      // Extract fields from Claude CLI JSON format
      const result = response.result || "";
      const sessionId = response.session_id || "";
      const totalCostUsd = response.total_cost_usd || 0;
      const usage = response.usage || {};

      const claudeResponse = {
        type: response.subtype === "success" ? "success" : "error",
        result,
        sessionId,
        usage: {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_tokens || 0,
          costUsd: totalCostUsd,
        },
        durationMs,
      } as ClaudeResponse;

      // Log model API call to observability
      observability.logModelApiCall({
        model: config.model || "claude",
        inputTokens: claudeResponse.usage.inputTokens,
        outputTokens: claudeResponse.usage.outputTokens,
        cacheReadTokens: claudeResponse.usage.cacheReadTokens,
        costUsd: claudeResponse.usage.costUsd,
        durationMs: claudeResponse.durationMs,
        sessionId: claudeResponse.sessionId,
      });

      return claudeResponse;
    } catch (parseError) {
      return {
        type: "error",
        result: `Failed to parse Claude CLI response: ${parseError instanceof Error ? parseError.message : String(parseError)}\nRaw output: ${stdout}`,
        sessionId: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        },
        durationMs,
      };
    }
  } catch (error) {
    // Clear timeout if it was set
    if (timeoutId) {
      env.process.clearTimeout(timeoutId);
    }

    const durationMs = env.clock.now() - startTime;

    return {
      type: "error",
      result: error instanceof Error ? error.message : String(error),
      sessionId: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      },
      durationMs,
    };
  }
}

/**
 * Call Claude CLI with streaming output.
 *
 * Spawns `claude` subprocess with stream-json output format and emits events
 * line-by-line as Claude produces output.
 *
 * @param request - The prompt and system prompt to send
 * @param config - Configuration for Claude CLI execution
 * @param onEvent - Callback to handle stream events
 * @param env - Environment for subprocess and clock
 * @returns Complete response text after stream completes
 */
export async function callClaudeStream(
  request: ClaudeRequest,
  config: ClaudeCliConfig,
  onEvent: StreamCallback,
  env: Environment = createNodeEnvironment()
): Promise<ClaudeResponse> {
  const startTime = env.clock.now();

  // Build command arguments for streaming
  const args = [
    "-p", // Print mode
    "--output-format",
    "stream-json",
  ];

  // Only include system prompt for new sessions (not when continuing)
  if (!request.continueSession) {
    args.push("--system-prompt", request.systemPrompt);
  }

  // Add optional arguments
  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (config.tools && config.tools.length > 0) {
    args.push("--tools", config.tools.join(","));
  }

  // Add continue flag for session continuation
  if (request.continueSession) {
    args.push("--continue", request.continueSession);
  }

  // Log the request
  const session = request.continueSession ? `continue:${request.continueSession}` : "new";
  log.info("[claude-cli]", `Streaming request [session=${session}, model=${config.model || "default"}]: ${request.prompt}`);

  // Spawn subprocess
  const child = env.subprocess.spawn("claude", args, {
    cwd: config.workingDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdout || !child.stderr || !child.stdin) {
    const errorEvent: StreamEvent = {
      type: "error",
      message: "Claude CLI stdio not available (expected piped stdio).",
    };
    await onEvent(errorEvent);
    
    return {
      type: "error",
      result: "Claude CLI stdio not available (expected piped stdio).",
      sessionId: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      },
      durationMs: env.clock.now() - startTime,
    };
  }

  // Set up timeout if specified
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    if (config.timeout) {
      timeoutId = env.process.setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Claude CLI timeout after ${config.timeout}ms`));
      }, config.timeout);
    }
  });

  // Collect complete response and metadata
  let completeResult = "";
  let sessionId = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
  };
  let stderr = "";
  let buffer = "";

  // Process stdout line-by-line
  child.stdout.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        
        // Handle different event types from Claude CLI stream-json format
        if (event.type === "text") {
          // Text delta event
          const text = event.text || "";
          completeResult += text;
          
          const streamEvent: StreamEvent = {
            type: "token",
            text,
          };
          await onEvent(streamEvent);
        } else if (event.type === "tool_use") {
          // Tool call event
          const streamEvent: StreamEvent = {
            type: "tool_call",
            id: event.id || "",
            name: event.name || "",
            input: event.input || {},
          };
          await onEvent(streamEvent);
        } else if (event.type === "tool_result") {
          // Tool result event
          const streamEvent: StreamEvent = {
            type: "tool_result",
            id: event.tool_use_id || event.id || "",
            output: typeof event.content === "string" ? event.content : JSON.stringify(event.content || ""),
          };
          await onEvent(streamEvent);
        } else if (event.type === "result") {
          // Final result with metadata
          completeResult = event.result || completeResult;
          sessionId = event.session_id || "";
          
          const eventUsage = event.usage || {};
          usage = {
            inputTokens: eventUsage.input_tokens || 0,
            outputTokens: eventUsage.output_tokens || 0,
            cacheReadTokens: eventUsage.cache_read_tokens || 0,
            costUsd: event.total_cost_usd || 0,
          };
        }
      } catch (parseError) {
        // Skip malformed JSON lines
        log.error("[claude-cli]", `Failed to parse stream event: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // Write prompt to stdin and close it
  child.stdin.write(request.prompt);
  child.stdin.end();

  // Wait for process to complete or timeout
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on("error", (error) => {
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    child.on("exit", (code) => {
      resolve(code);
    });
  });

  try {
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);

    // Clear timeout if it was set
    if (timeoutId) {
      env.process.clearTimeout(timeoutId);
    }

    const durationMs = env.clock.now() - startTime;

    // Log stderr if present
    if (stderr) {
      log.info("[claude-cli]", `stderr:\n${stderr}`);
    }

    // Handle non-zero exit code
    if (exitCode !== 0) {
      const errorEvent: StreamEvent = {
        type: "error",
        message: `Claude CLI exited with code ${exitCode}`,
      };
      await onEvent(errorEvent);
      
      return {
        type: "error",
        result: `Claude CLI exited with code ${exitCode}\nStderr: ${stderr}`,
        sessionId: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0,
        },
        durationMs,
      };
    }

    // Emit done event
    const doneEvent: StreamEvent = {
      type: "done",
      sessionId,
      usage,
      durationMs,
    };
    await onEvent(doneEvent);

    // Log model API call to observability
    observability.logModelApiCall({
      model: config.model || "claude",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: usage.costUsd,
      durationMs,
      sessionId,
    });

    return {
      type: "success",
      result: completeResult,
      sessionId,
      usage,
      durationMs,
    };
  } catch (error) {
    // Clear timeout if it was set
    if (timeoutId) {
      env.process.clearTimeout(timeoutId);
    }

    const durationMs = env.clock.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    const errorEvent: StreamEvent = {
      type: "error",
      message: errorMessage,
    };
    await onEvent(errorEvent);

    return {
      type: "error",
      result: errorMessage,
      sessionId: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      },
      durationMs,
    };
  }
}
