/**
 * claude-api.ts — Anthropic API provider for daemon-engine.
 *
 * Implements the LlmProvider interface for Anthropic's Claude models using direct API calls.
 * This is the "api" mode (direct billing) as opposed to "cli" mode (Claude Code billing hack).
 * 
 * Retry behavior:
 * - Automatically retries on transient errors (429, 503, 500, network errors)
 * - Exponential backoff: 1s initial delay, 2x multiplier, max 60s delay
 * - Configurable via retry config (enabled, maxAttempts, delays)
 * - Default: 5 retry attempts with retry enabled
 */

import Anthropic from "@anthropic-ai/sdk";
import { LlmProvider, ProviderRequest, ProviderResponse, StreamEvent, Usage, Message, ToolDefinitionLike, ToolCall } from "./types.js";
import { Environment } from "../env/environment.js";
import { log } from "../logger.js";
import { withRetry, DEFAULT_RETRY_CONFIG, RetryConfig } from "../retry.js";
import { observability } from "../observability.js";

/**
 * Configuration for Anthropic API provider.
 */
export interface ClaudeApiConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Model identifier (e.g., "claude-3-5-sonnet-20241022") */
  model?: string;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * Anthropic API provider using direct API calls.
 * Uses the official @anthropic-ai/sdk for direct API billing.
 */
export class ClaudeApiProvider implements LlmProvider {
  private config: ClaudeApiConfig;
  private client: Anthropic;

  constructor(config: ClaudeApiConfig) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  /**
   * Convert internal Message format to Anthropic MessageParam format.
   */
  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    // Anthropic doesn't support "system" role in messages array
    // System messages should be passed via the system parameter
    return messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  /**
   * Convert ToolDefinitionLike to Anthropic Tool format.
   */
  private convertToolDefinitions(toolDefinitions: ToolDefinitionLike[]): Anthropic.Tool[] {
    if (!toolDefinitions || toolDefinitions.length === 0) {
      return [];
    }

    return toolDefinitions.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    }));
  }

  /**
   * Extract tool calls from Anthropic response.
   */
  private extractToolCalls(response: Anthropic.Message): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    return toolCalls;
  }

  /**
   * Map Anthropic stop reason to standard format.
   */
  private mapStopReason(stopReason: string | null): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
    switch (stopReason) {
      case "end_turn":
        return "end_turn";
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  /**
   * Extract text content from Anthropic response.
   */
  private extractTextContent(response: Anthropic.Message): string {
    const textBlocks = response.content.filter(block => block.type === "text");
    return textBlocks.map(block => (block as Anthropic.TextBlock).text).join("");
  }

  /**
   * Convert Anthropic usage to standard Usage format.
   */
  private convertUsage(usage: Anthropic.Usage): Usage {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens || 0,
      costUsd: 0, // Anthropic API doesn't return cost; would need to calculate based on pricing
    };
  }

  /**
   * Non-streaming generation call.
   */
  async generate(
    request: ProviderRequest,
    env?: Environment
  ): Promise<ProviderResponse> {
    const startTime = env?.clock.now() || Date.now();
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;

    try {
      const response = await withRetry(
        async () => {
          const anthropicMessages = this.convertMessages(request.messages);
          const tools = request.toolDefinitions ? this.convertToolDefinitions(request.toolDefinitions) : undefined;

          const apiRequest: Anthropic.MessageCreateParams = {
            model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
            max_tokens: this.config.maxTokens || 4096,
            messages: anthropicMessages,
            system: request.systemPrompt,
          };

          if (tools && tools.length > 0) {
            apiRequest.tools = tools;
          }

          log.info("[claude-api]", `Calling Anthropic API with ${anthropicMessages.length} messages, model: ${apiRequest.model}`);

          return await this.client.messages.create(apiRequest);
        },
        retryConfig,
        "[claude-api]",
        env
      );

      const durationMs = (env?.clock.now() || Date.now()) - startTime;
      const usage = this.convertUsage(response.usage);
      const toolCalls = this.extractToolCalls(response);
      const stopReason = this.mapStopReason(response.stop_reason);
      const textContent = this.extractTextContent(response);

      // Log to observability
      observability.logModelApiCall({
        model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: usage.costUsd,
        durationMs,
        sessionId: response.id,
      });

      return {
        type: "success",
        result: textContent,
        sessionId: response.id,
        usage,
        durationMs,
        stopReason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      const durationMs = (env?.clock.now() || Date.now()) - startTime;
      log.error("[claude-api]", `Error calling Anthropic API: ${error instanceof Error ? error.message : String(error)}`);

      return {
        type: "error",
        result: error instanceof Error ? error.message : String(error),
        sessionId: undefined,
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
   * Streaming generation call.
   */
  async generateStream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    env?: Environment
  ): Promise<ProviderResponse> {
    const startTime = env?.clock.now() || Date.now();
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;

    try {
      const anthropicMessages = this.convertMessages(request.messages);
      const tools = request.toolDefinitions ? this.convertToolDefinitions(request.toolDefinitions) : undefined;

      const apiRequest: Anthropic.MessageCreateParams = {
        model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
        max_tokens: this.config.maxTokens || 4096,
        messages: anthropicMessages,
        system: request.systemPrompt,
        stream: true,
      };

      if (tools && tools.length > 0) {
        apiRequest.tools = tools;
      }

      log.info("[claude-api]", `Streaming from Anthropic API with ${anthropicMessages.length} messages, model: ${apiRequest.model}`);

      // Retry only the initial connection, not mid-stream
      const stream = await withRetry(
        async () => await this.client.messages.create(apiRequest),
        retryConfig,
        "[claude-api]",
        env
      );

      let completeText = "";
      let sessionId = "";
      let usage: Usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
      };
      const toolCalls: ToolCall[] = [];
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";

      // Process stream events
      for await (const event of stream) {
        if (event.type === "message_start") {
          sessionId = event.message.id;
          usage = this.convertUsage(event.message.usage);
        } else if (event.type === "content_block_start") {
          // Start of a content block (text or tool use)
          if (event.content_block.type === "tool_use") {
            // Tool use block started
            const toolCall: ToolCall = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: event.content_block.input,
            };
            toolCalls.push(toolCall);

            await onEvent({
              type: "tool_call",
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.input,
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const text = event.delta.text;
            completeText += text;
            await onEvent({
              type: "token",
              text,
            });
          } else if (event.delta.type === "input_json_delta") {
            // Tool use input is being streamed
            // We already have the complete input from content_block_start
            // so we can ignore these deltas
          }
        } else if (event.type === "message_delta") {
          // Update stop reason
          if (event.delta.stop_reason) {
            stopReason = this.mapStopReason(event.delta.stop_reason);
          }
          // Update usage if provided
          if (event.usage) {
            usage.outputTokens = event.usage.output_tokens;
          }
        } else if (event.type === "message_stop") {
          // Message completed
        }
      }

      const durationMs = (env?.clock.now() || Date.now()) - startTime;

      // Emit done event
      await onEvent({
        type: "done",
        sessionId,
        usage,
        durationMs,
      });

      // Log to observability
      observability.logModelApiCall({
        model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd: usage.costUsd,
        durationMs,
        sessionId,
      });

      return {
        type: "success",
        result: completeText,
        sessionId,
        usage,
        durationMs,
        stopReason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      const durationMs = (env?.clock.now() || Date.now()) - startTime;
      log.error("[claude-api]", `Error streaming from Anthropic API: ${error instanceof Error ? error.message : String(error)}`);

      await onEvent({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });

      return {
        type: "error",
        result: error instanceof Error ? error.message : String(error),
        sessionId: undefined,
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
}
