/**
 * claude-adapter.ts — Adapter to make Claude CLI conform to LlmProvider interface.
 */

import { LlmProvider, ProviderRequest, ProviderResponse, StreamEvent } from "./types.js";
import { callClaude, callClaudeStream, ClaudeCliConfig } from "./claude-cli.js";
import type { Environment } from "../env/environment.js";
import type { ToolDefinition } from "../agent.js";

export class ClaudeCliProvider implements LlmProvider {
  private config: ClaudeCliConfig;

  constructor(config: ClaudeCliConfig = {}) {
    this.config = config;
  }

  /**
   * Convert ToolDefinition map to Claude CLI tool names.
   * 
   * Claude CLI currently only supports built-in tools via --tools flag.
   * This extracts tool names from the ToolDefinition map.
   * For custom tools, future implementations could use MCP or direct Anthropic API.
   */
  private convertToolsToNames(tools?: Record<string, ToolDefinition>): string[] | undefined {
    if (!tools || Object.keys(tools).length === 0) {
      return undefined;
    }
    return Object.keys(tools);
  }

  async generate(
    request: ProviderRequest,
    env?: Environment
  ): Promise<ProviderResponse> {
    const claudeRequest = {
      messages: request.messages,
      systemPrompt: request.systemPrompt,
    };

    const claudeConfig: ClaudeCliConfig = {
      ...this.config,
      model: request.model || this.config.model,
      timeout: request.timeout || this.config.timeout,
      tools: this.convertToolsToNames(request.tools) || this.config.tools,
    };

    const response = await callClaude(claudeRequest, claudeConfig, env);

    return {
      type: response.type,
      result: response.result,
      sessionId: response.sessionId,
      usage: response.usage,
      durationMs: response.durationMs,
    };
  }

  async generateStream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    env?: Environment
  ): Promise<ProviderResponse> {
    const claudeRequest = {
      messages: request.messages,
      systemPrompt: request.systemPrompt,
    };

    const claudeConfig: ClaudeCliConfig = {
      ...this.config,
      model: request.model || this.config.model,
      timeout: request.timeout || this.config.timeout,
      tools: this.convertToolsToNames(request.tools) || this.config.tools,
    };

    // Adapt Claude stream events to generic StreamEvent
    const adaptedOnEvent = async (event: StreamEvent) => {
      // The types are currently identical in structure, so direct pass-through works.
      await onEvent(event);
    };

    const response = await callClaudeStream(claudeRequest, claudeConfig, adaptedOnEvent, env);

    return {
      type: response.type,
      result: response.result,
      sessionId: response.sessionId,
      usage: response.usage,
      durationMs: response.durationMs,
    };
  }
}
