/**
 * agent.ts — LLM call loop (message → tools → response).
 *
 * This module defines the core agent interface and tool execution model.
 * Tools are async functions with typed parameters that the agent can call.
 * 
 * The runAgent function implements the ReAct loop: the agent calls the LLM,
 * executes any requested tools, and continues until a final response is reached.
 */

import type { Environment } from "./env/environment.js";
import type { Config } from "./config.js";
import type { LlmProvider, Message, ProviderResponse, ToolDefinitionLike } from "./providers/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import { log } from "./logger.js";

/**
 * Context provided to tool execution.
 *
 * Contains all the runtime context needed for tools to operate:
 * workspace directory, environment abstraction, session identifier, and config.
 */
export interface ToolContext {
  /** Absolute path to the workspace directory. */
  workspace: string;
  /** Environment abstraction for filesystem, subprocess, etc. */
  env: Environment;
  /** Unique session identifier (e.g., "agent:main:webchat"). */
  sessionKey: string;
  /** Runtime configuration (optional). */
  config?: Config;
}

/**
 * A tool that the agent can execute.
 *
 * Each tool has a name, description, parameter schema, and an execute function.
 * The execute function receives validated parameters and a context object.
 */
export interface ToolDefinition<T = unknown> {
  /** Human-readable description of what the tool does. */
  description: string;

  /** JSON Schema describing the tool's parameters. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };

  /** Execute the tool with the given parameters and context. Returns a result string. */
  execute: (params: T, context: ToolContext) => Promise<string>;
}

/**
 * Parameters for running the agent execution loop.
 */
export interface RunAgentParams {
  /** LLM provider to use for generation. */
  provider: LlmProvider;
  /** Tool registry for executing tool calls. */
  toolRegistry: ToolRegistry;
  /** Initial conversation messages. */
  messages: Message[];
  /** System prompt. */
  systemPrompt: string;
  /** Tool execution context. */
  toolContext: ToolContext;
  /** Environment abstraction. */
  env: Environment;
  /** Maximum number of agent turns (LLM calls) to prevent infinite loops. Default: 10. */
  maxTurns?: number;
}

/**
 * Result from the agent execution loop.
 */
export interface RunAgentResult {
  /** Final response text from the agent. */
  result: string;
  /** Accumulated messages including tool interactions. */
  messages: Message[];
  /** Total token usage across all turns. */
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  /** Total duration in milliseconds. */
  totalDurationMs: number;
  /** Number of turns executed. */
  turns: number;
}

/**
 * Convert a ToolDefinition to the provider-compatible format.
 */
function convertToolDefinition(name: string, tool: ToolDefinition): ToolDefinitionLike {
  return {
    name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/**
 * Run the agent execution loop with tool support.
 * 
 * Implements the ReAct pattern:
 * 1. Call LLM with messages and tool definitions
 * 2. If LLM requests tool use:
 *    - Execute the tool via ToolRegistry
 *    - Append tool result to messages
 *    - Loop back to step 1
 * 3. Else: Return final response
 * 
 * Includes safety mechanism to prevent infinite loops via maxTurns.
 * 
 * @param params - Agent execution parameters
 * @returns Agent execution result with final response and accumulated state
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const {
    provider,
    toolRegistry,
    messages: initialMessages,
    systemPrompt,
    toolContext,
    env,
    maxTurns = 10,
  } = params;

  // Convert ToolRegistry to provider format
  const toolDefinitions: ToolDefinitionLike[] = [];
  for (const [name, tool] of toolRegistry.getAll()) {
    toolDefinitions.push(convertToolDefinition(name, tool));
  }

  // Initialize state
  const messages = [...initialMessages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let turns = 0;
  let finalResult = "";

  // Agent execution loop
  while (turns < maxTurns) {
    turns++;
    log.info("[agent]", `Turn ${turns}/${maxTurns}: Calling LLM with ${messages.length} messages and ${toolDefinitions.length} tools`);

    // Call LLM
    let response: ProviderResponse;
    try {
      response = await provider.generate(
        {
          messages,
          systemPrompt,
          toolDefinitions,
        },
        env
      );
    } catch (error) {
      log.error("[agent]", `LLM call failed on turn ${turns}: ${error}`);
      throw error;
    }

    // Accumulate usage stats
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    totalCacheReadTokens += response.usage.cacheReadTokens;
    totalCostUsd += response.usage.costUsd;
    totalDurationMs += response.durationMs;

    // Check for error
    if (response.type === "error") {
      log.error("[agent]", `LLM returned error: ${response.result}`);
      throw new Error(`LLM error: ${response.result}`);
    }

    // Check if LLM requested tool use
    if (response.stopReason === "tool_use" && response.toolCalls && response.toolCalls.length > 0) {
      log.info("[agent]", `LLM requested ${response.toolCalls.length} tool call(s)`);

      // Add assistant message with tool calls (if there's content)
      if (response.result && response.result.trim().length > 0) {
        messages.push({
          role: "assistant",
          content: response.result,
        });
      }

      // Execute each tool call
      for (const toolCall of response.toolCalls) {
        log.info("[agent]", `Executing tool: ${toolCall.name} with id ${toolCall.id}`);

        // Get tool from registry
        const tool = toolRegistry.get(toolCall.name);
        if (!tool) {
          const errorMsg = `Tool not found: ${toolCall.name}`;
          log.error("[agent]", errorMsg);
          // Add error as tool result
          messages.push({
            role: "user",
            content: `Tool execution error for ${toolCall.name}: Tool not found in registry`,
          });
          continue;
        }

        // Execute tool
        let toolResult: string;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolResult = await tool.execute(toolCall.input as any, toolContext);
          log.info("[agent]", `Tool ${toolCall.name} executed successfully, result length: ${toolResult.length}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error("[agent]", `Tool ${toolCall.name} execution failed: ${errorMsg}`);
          toolResult = `Error executing tool: ${errorMsg}`;
        }

        // Add tool result to messages as a user message
        // Note: In a more sophisticated implementation, we might use a special role or format
        messages.push({
          role: "user",
          content: `Tool result for ${toolCall.name} (id: ${toolCall.id}):\n${toolResult}`,
        });
      }

      // Continue loop to call LLM again with tool results
      continue;
    }

    // No tool use - we have the final response
    log.info("[agent]", `Agent completed after ${turns} turn(s)`);
    finalResult = response.result;

    // Add final assistant message to history
    if (finalResult && finalResult.trim().length > 0) {
      messages.push({
        role: "assistant",
        content: finalResult,
      });
    }

    break;
  }

  // Check if we hit max turns
  if (turns >= maxTurns && !finalResult) {
    log.info("[agent]", `Agent hit max turns (${maxTurns}) without final response`);
    finalResult = "Error: Agent execution exceeded maximum turns without completing.";
  }

  return {
    result: finalResult,
    messages,
    totalUsage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      costUsd: totalCostUsd,
    },
    totalDurationMs,
    turns,
  };
}
