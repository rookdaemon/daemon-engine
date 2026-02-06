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
 * Message structure for Claude API.
 * Based on Claude's Messages API format.
 */
export interface Message {
  /** Role of the message sender. */
  role: "user" | "assistant";
  /** Text content of the message. */
  content: string;
}

/**
 * Request structure for Claude CLI invocation.
 * Supports both legacy single-prompt mode and new messages array mode.
 */
export interface ClaudeRequest {
  /** The user prompt to send to Claude (legacy mode). */
  prompt?: string;
  /** Messages array for conversation history (new mode). */
  messages?: Message[];
  /** System prompt to configure behavior. */
  systemPrompt: string;
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
 * Convert messages array to text format for Claude CLI input.
 * 
 * Formats messages as a conversation with clear role labels:
 * "User: ...\n\nAssistant: ...\n\nUser: ..."
 */
function formatMessagesAsText(messages: Message[]): string {
  return messages.map(msg => {
    if (msg.role === "user") {
      return `User: ${msg.content}`;
    } else {
      return `Assistant: ${msg.content}`;
    }
  }).join("\n\n");
}

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
    "--system-prompt",
    request.systemPrompt,
  ];

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

  // Determine the input to send (messages array or single prompt)
  let inputText: string;
  if (request.messages) {
    // Convert messages array to text format for Claude CLI
    inputText = formatMessagesAsText(request.messages);
    log.info("[claude-cli]", `Request [session=new, model=${config.model || "default"}, messages=${request.messages.length}]`);
  } else if (request.prompt) {
    inputText = request.prompt;
    log.info("[claude-cli]", `Request [session=new, model=${config.model || "default"}]: ${request.prompt}`);
  } else {
    throw new Error("ClaudeRequest must have either 'prompt' or 'messages'");
  }

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

  // Write input to stdin and close it
  child.stdin.write(inputText);
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
    "--verbose",
    "--system-prompt",
    request.systemPrompt,
  ];

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

  // Determine the input to send (messages array or single prompt)
  let inputText: string;
  if (request.messages) {
    // Convert messages array to text format for Claude CLI
    inputText = formatMessagesAsText(request.messages);
    log.info("[claude-cli]", `Streaming request [session=new, model=${config.model || "default"}, messages=${request.messages.length}]`);
  } else if (request.prompt) {
    inputText = request.prompt;
    log.info("[claude-cli]", `Streaming request [session=new, model=${config.model || "default"}]: ${request.prompt}`);
  } else {
    throw new Error("ClaudeRequest must have either 'prompt' or 'messages'");
  }

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
  let eventCount = 0; // Track event count for debugging

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
        eventCount++;
        
        // Log first 10 events in full detail for debugging
        if (eventCount <= 10) {
          log.info("[claude-cli]", `Stream event #${eventCount}: ${JSON.stringify(event)}`);
        } else if (event.type !== "text" && event.type !== "content_block_delta" && event.type !== "message_delta") {
          // After first 10, only log non-text events to avoid spam
          log.info("[claude-cli]", `Stream event #${eventCount}: type=${event.type}, keys=${Object.keys(event).join(", ")}`);
        }
        
        // Handle different event types from Claude CLI stream-json format
        // Try to extract text from various possible event structures
        let extractedText = "";
        let eventHandled = false; // Track if we've handled this event type
        
        if (event.type === "text" || event.type === "content_block_delta" || event.type === "message_delta") {
          // Text delta event - support multiple formats
          if (event.text && typeof event.text === "string") {
            extractedText = event.text;
          } else if (event.delta) {
            if (typeof event.delta === "string") {
              extractedText = event.delta;
            } else if (event.delta.text && typeof event.delta.text === "string") {
              extractedText = event.delta.text;
            } else if (event.delta.type === "text" && typeof event.delta.text === "string") {
              extractedText = event.delta.text;
            }
          }
          eventHandled = true;
        } else if (event.type === "assistant") {
          // Assistant event with message content blocks
          // Extract text from content array: [{"type":"text","text":"..."}]
          eventHandled = true; // Mark as handled even if extraction fails
          if (event.message && event.message.content) {
            if (Array.isArray(event.message.content)) {
              extractedText = event.message.content
                .map((block: unknown) => {
                  if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
                    return typeof block.text === "string" ? block.text : "";
                  }
                  return "";
                })
                .join("");
              if (extractedText) {
                log.info("[claude-cli]", `Extracted ${extractedText.length} chars from assistant event`);
              } else {
                log.info("[claude-cli]", `Assistant event has content array but no text extracted. Content: ${JSON.stringify(event.message.content).substring(0, 200)}`);
              }
            } else {
              log.info("[claude-cli]", `Assistant event message.content is not an array: ${typeof event.message.content}`);
            }
          } else {
            log.info("[claude-cli]", `Assistant event missing message or message.content. Keys: ${event.message ? Object.keys(event.message).join(", ") : "no message"}`);
          }
        } else if (event.type === "content_block" || event.type === "content_block_start" || event.type === "message_start") {
          // Content block start - may contain initial text
          extractedText = event.text || event.content || "";
          // Also check if content is an array with text blocks
          if (!extractedText && Array.isArray(event.content)) {
            extractedText = event.content
              .map((block: unknown) => {
                if (typeof block === "string") return block;
                if (block && typeof block === "object" && "text" in block) {
                  return typeof block.text === "string" ? block.text : "";
                }
                return "";
              })
              .join("");
          }
          eventHandled = true;
        }
        
        // If we extracted text, emit it as a token event
        if (extractedText && typeof extractedText === "string" && extractedText.length > 0) {
          completeResult += extractedText;
          
          const streamEvent: StreamEvent = {
            type: "token",
            text: extractedText,
          };
          await onEvent(streamEvent);
        }
        
        // Handle tool events
        if (event.type === "tool_use") {
          // Tool call event
          eventHandled = true;
          const streamEvent: StreamEvent = {
            type: "tool_call",
            id: event.id || "",
            name: event.name || "",
            input: event.input || {},
          };
          await onEvent(streamEvent);
        } else if (event.type === "tool_result") {
          // Tool result event
          eventHandled = true;
          const streamEvent: StreamEvent = {
            type: "tool_result",
            id: event.tool_use_id || event.id || "",
            output: typeof event.content === "string" ? event.content : JSON.stringify(event.content || ""),
          };
          await onEvent(streamEvent);
        } else if (event.type === "result" || event.type === "message_done" || event.type === "message_stop") {
          eventHandled = true;
          // Final result with metadata
          // Try to extract result text from various possible fields
          let resultText = "";
          
          // Helper function to recursively extract text from nested structures
          const extractTextFromValue = (value: unknown): string => {
            if (typeof value === "string") {
              return value;
            }
            if (Array.isArray(value)) {
              return value.map(extractTextFromValue).join("");
            }
            if (value && typeof value === "object") {
              // Check common text fields
              if ("text" in value && typeof value.text === "string") {
                return value.text;
              }
              if ("content" in value) {
                return extractTextFromValue(value.content);
              }
              // Try to extract from all string values in the object
              return Object.values(value)
                .map(extractTextFromValue)
                .join("");
            }
            return "";
          };
          
          // Try various fields
          if (event.result) {
            resultText = extractTextFromValue(event.result);
          }
          if (!resultText && event.content) {
            resultText = extractTextFromValue(event.content);
          }
          if (!resultText && event.message) {
            resultText = extractTextFromValue(event.message);
          }
          if (!resultText && event.response) {
            resultText = extractTextFromValue(event.response);
          }
          
          // Only update completeResult if we found text in the result event
          // Otherwise preserve accumulated text from stream events
          if (resultText.length > 0) {
            completeResult = resultText;
            log.info("[claude-cli]", `Extracted ${resultText.length} chars from result event`);
          }
          
          // If completeResult is still empty but we have usage info, log a warning with full event
          if (!completeResult && (event.usage?.output_tokens || event.usage?.outputTokens || 0) > 0) {
            const outputTokens = event.usage?.output_tokens || event.usage?.outputTokens || 0;
            log.error("[claude-cli]", `Received result event with ${outputTokens} output tokens but no text content. Event keys: ${Object.keys(event).join(", ")}. Full event: ${JSON.stringify(event)}`);
          }
          
          sessionId = event.session_id || event.sessionId || "";
          
          const eventUsage = event.usage || {};
          usage = {
            inputTokens: eventUsage.input_tokens || eventUsage.inputTokens || 0,
            outputTokens: eventUsage.output_tokens || eventUsage.outputTokens || 0,
            cacheReadTokens: eventUsage.cache_read_tokens || eventUsage.cacheReadTokens || 0,
            costUsd: event.total_cost_usd || event.totalCostUsd || event.costUsd || 0,
          };
        }
        
        // Only log unknown event types if we haven't handled them
        if (!eventHandled) {
          // Log unknown event types for debugging (but limit log size)
          const eventStr = JSON.stringify(event);
          if (eventStr.length > 200) {
            log.info("[claude-cli]", `Received unknown stream event type: ${event.type}. Event preview: ${eventStr.substring(0, 200)}...`);
          } else {
            log.info("[claude-cli]", `Received unknown stream event type: ${event.type}. Event: ${eventStr}`);
          }
        }
      } catch (parseError) {
        // Skip malformed JSON lines
        log.error("[claude-cli]", `Failed to parse stream event: ${parseError instanceof Error ? parseError.message : String(parseError)}. Line: ${line}`);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  // Write input to stdin and close it
  child.stdin.write(inputText);
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

    // Log warning if we have token usage but no result text
    if (!completeResult && usage.outputTokens > 0) {
      log.error("[claude-cli]", `Stream completed with ${usage.outputTokens} output tokens but empty result text. This may indicate a parsing issue with Claude CLI stream format.`);
    }

    // Log the final response that will be returned
    log.info("[claude-cli]", `Stream completed. Final response length: ${completeResult.length} chars. Response preview: ${completeResult.substring(0, 200)}${completeResult.length > 200 ? "..." : ""}`);

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
