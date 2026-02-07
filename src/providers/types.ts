/**
 * types.ts — Interfaces for LLM providers.
 *
 * Defines the contract that all model providers (Claude, Gemini, etc.)
 * must implement to be used by the daemon-engine.
 */

import type { Environment } from "../env/environment.js";

/**
 * Message in the conversation.
 */
export interface Message {
  /** Message role: "user", "assistant", or "system". */
  role: "user" | "assistant" | "system";
  /** Message content/text. */
  content: string;
}

/**
 * Standardized usage statistics.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/**
 * Tool call request from the LLM.
 */
export interface ToolCall {
  /** Unique identifier for this tool call. */
  id: string;
  /** Name of the tool to execute. */
  name: string;
  /** Parameters to pass to the tool (parsed JSON). */
  input: unknown;
}

/**
 * Tool definition for provider request.
 * Simplified format that providers can convert to their specific schema.
 */
export interface ToolDefinitionLike {
  /** Tool name/identifier. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Standardized response from an LLM provider.
 */
export interface ProviderResponse {
  /** Result status. */
  type: "success" | "error";
  /** The text content or error message. */
  result: string;
  /** Provider-specific session ID (if applicable). */
  sessionId?: string;
  /** Token usage statistics. */
  usage: Usage;
  /** Duration of the call in milliseconds. */
  durationMs: number;
  /** Stop reason indicating why generation stopped. */
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  /** Tool calls requested by the LLM (present when stopReason is "tool_use"). */
  toolCalls?: ToolCall[];
}

/**
 * Stream event types.
 */
export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId?: string; usage: Usage; durationMs: number };

/**
 * Request parameters for LLM generation.
 */
export interface ProviderRequest {
  /** Conversation history. */
  messages: Message[];
  /** System prompt. */
  systemPrompt: string;
  /** Model identifier. */
  model?: string;
  /** Available tools (provider-specific format or abstract). 
   * @deprecated Use toolDefinitions instead for structured tool support.
   */
  tools?: string[];
  /** Tool definitions in standard format. */
  toolDefinitions?: ToolDefinitionLike[];
  /** Timeout in milliseconds. */
  timeout?: number;
}

/**
 * Interface for an LLM provider.
 */
export interface LlmProvider {
  /**
   * blocking generation call.
   */
  generate(
    request: ProviderRequest,
    env?: Environment
  ): Promise<ProviderResponse>;

  /**
   * Streaming generation call.
   */
  generateStream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    env?: Environment
  ): Promise<ProviderResponse>;
}
