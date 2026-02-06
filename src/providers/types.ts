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
  /** Available tools (provider-specific format or abstract). */
  tools?: string[];
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
