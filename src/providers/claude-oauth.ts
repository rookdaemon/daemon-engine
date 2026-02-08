/**
 * claude-oauth.ts — Anthropic OAuth session token provider for daemon-engine.
 *
 * Uses OAuth session tokens (sk-ant-oat) with 1-to-1 client creation, headers,
 * system prompt, and tool handling as pi-mono packages/ai/src/providers/anthropic.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  Usage,
  Message,
  ToolDefinitionLike,
  ToolCall,
} from "./types.js";
import type { Environment } from "../env/environment.js";
import { log } from "../logger.js";
import { withRetry, DEFAULT_RETRY_CONFIG, type RetryConfig } from "../retry.js";
import { observability } from "../observability.js";
import { resolveSessionToken } from "./anthropic-oauth-credentials.js";
import { createNodeEnvironment } from "../env/environment.js";

const CLAUDE_CODE_VERSION = "2.1.2";
const BETA_FEATURES =
  "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// Claude Code 2.x tool names (canonical casing) - from pi-mono
const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

const CC_TO_REGISTRY = new Map<string, string>([
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Bash", "exec"],
  ["Grep", "grep"],
  ["Glob", "glob"],
  ["WebSearch", "web_search"],
  ["WebFetch", "web_fetch"],
]);

const ccToolLookup = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));
// daemon-engine uses "exec" for shell commands; Claude Code uses "Bash"
ccToolLookup.set("exec", "Bash");

function toClaudeCodeName(name: string): string {
  return ccToolLookup.get(name.toLowerCase()) ?? name;
}

function fromClaudeCodeName(apiName: string, toolDefinitions: ToolDefinitionLike[]): string {
  const registry = CC_TO_REGISTRY.get(apiName);
  if (registry) return registry;
  const lower = apiName.toLowerCase();
  const match = toolDefinitions.find((t) => t.name.toLowerCase() === lower);
  return match ? match.name : apiName;
}

export interface ClaudeOAuthConfig {
  /** Session token (sk-ant-oat) - or from ANTHROPIC_OAUTH_TOKEN */
  sessionToken?: string;
  /** Path to credential store JSON (optional) */
  credentialStorePath?: string;
  /** Model identifier */
  model?: string;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Maximum tokens to generate */
  maxTokens?: number;
}

/**
 * Anthropic OAuth provider using session tokens.
 * 1-to-1 with pi-mono session token flow: authToken, Claude Code headers, identity prompt, tool names.
 */
export class ClaudeOAuthProvider implements LlmProvider {
  private config: ClaudeOAuthConfig;
  private env: Environment;

  constructor(config: ClaudeOAuthConfig, env: Environment = createNodeEnvironment()) {
    this.config = config;
    this.env = env;
  }

  private getDefaultHeaders(): Record<string, string> {
    return {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": BETA_FEATURES,
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      "x-app": "cli",
    };
  }

  private async createClient(env: Environment): Promise<Anthropic> {
    const token = await resolveSessionToken({
      sessionToken: this.config.sessionToken,
      credentialStorePath: this.config.credentialStorePath,
      env,
    });
    return new Anthropic({
      apiKey: null as unknown as string,
      authToken: token,
      defaultHeaders: this.getDefaultHeaders(),
      dangerouslyAllowBrowser: true,
    });
  }

  private buildSystemPrompt(userPrompt: string): string {
    if (userPrompt && userPrompt.trim().length > 0) {
      return `${CLAUDE_CODE_IDENTITY}\n\n${userPrompt}`;
    }
    return CLAUDE_CODE_IDENTITY;
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  private convertToolDefinitions(toolDefinitions: ToolDefinitionLike[]): Anthropic.Tool[] {
    if (!toolDefinitions || toolDefinitions.length === 0) return [];
    return toolDefinitions.map((tool) => ({
      name: toClaudeCodeName(tool.name),
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: tool.parameters.properties,
        required: tool.parameters.required,
      },
    }));
  }

  private extractToolCalls(
    response: Anthropic.Message,
    toolDefinitions: ToolDefinitionLike[]
  ): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: fromClaudeCodeName(block.name, toolDefinitions),
          input: block.input,
        });
      }
    }
    return toolCalls;
  }

  private mapStopReason(
    stopReason: string | null
  ): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
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

  private extractTextContent(response: Anthropic.Message): string {
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    return textBlocks.map((block) => block.text).join("");
  }

  private convertUsage(usage: Anthropic.Usage): Usage {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens:
        (usage as { cache_read_input_tokens?: number }).cache_read_input_tokens || 0,
      costUsd: 0,
    };
  }

  async generate(request: ProviderRequest, env?: Environment): Promise<ProviderResponse> {
    const effectiveEnv = env ?? this.env;
    const startTime = effectiveEnv.clock.now();
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;

    try {
      const client = await this.createClient(effectiveEnv);
      const anthropicMessages = this.convertMessages(request.messages);
      const tools = request.toolDefinitions
        ? this.convertToolDefinitions(request.toolDefinitions)
        : undefined;
      const systemPrompt = this.buildSystemPrompt(request.systemPrompt);

      const response = await withRetry(
        async () => {
          const apiRequest: Anthropic.MessageCreateParams = {
            model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
            max_tokens: this.config.maxTokens || 4096,
            messages: anthropicMessages,
            system: systemPrompt,
          };
          if (tools && tools.length > 0) apiRequest.tools = tools;

          log.info(
            "[claude-oauth]",
            `Calling Anthropic API with ${anthropicMessages.length} messages, model: ${apiRequest.model}`
          );
          return await client.messages.create(apiRequest);
        },
        retryConfig,
        "[claude-oauth]",
        effectiveEnv
      );

      const durationMs = effectiveEnv.clock.now() - startTime;
      const usage = this.convertUsage(response.usage);
      const toolCalls = this.extractToolCalls(
        response,
        request.toolDefinitions || []
      );
      const stopReason = this.mapStopReason(response.stop_reason);
      const textContent = this.extractTextContent(response);

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
      const durationMs = effectiveEnv.clock.now() - startTime;
      log.error(
        "[claude-oauth]",
        `Error calling Anthropic API: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        type: "error",
        result: error instanceof Error ? error.message : String(error),
        sessionId: undefined,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        durationMs,
      };
    }
  }

  async generateStream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    env?: Environment
  ): Promise<ProviderResponse> {
    const effectiveEnv = env ?? this.env;
    const startTime = effectiveEnv.clock.now();
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;

    try {
      const client = await this.createClient(effectiveEnv);
      const anthropicMessages = this.convertMessages(request.messages);
      const tools = request.toolDefinitions
        ? this.convertToolDefinitions(request.toolDefinitions)
        : undefined;
      const systemPrompt = this.buildSystemPrompt(request.systemPrompt);

      const apiRequest: Anthropic.MessageCreateParams = {
        model: request.model || this.config.model || "claude-3-5-sonnet-20241022",
        max_tokens: this.config.maxTokens || 4096,
        messages: anthropicMessages,
        system: systemPrompt,
        stream: true,
      };
      if (tools && tools.length > 0) apiRequest.tools = tools;

      log.info(
        "[claude-oauth]",
        `Streaming from Anthropic API with ${anthropicMessages.length} messages, model: ${apiRequest.model}`
      );

      const stream = await withRetry(
        async () => await client.messages.create(apiRequest),
        retryConfig,
        "[claude-oauth]",
        effectiveEnv
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

      for await (const event of stream) {
        if (event.type === "message_start") {
          sessionId = event.message.id;
          usage = this.convertUsage(event.message.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            const tc: ToolCall = {
              id: event.content_block.id,
              name: fromClaudeCodeName(
                event.content_block.name,
                request.toolDefinitions || []
              ),
              input: event.content_block.input,
            };
            toolCalls.push(tc);
            await onEvent({ type: "tool_call", id: tc.id, name: tc.name, input: tc.input });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            completeText += event.delta.text;
            await onEvent({ type: "token", text: event.delta.text });
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            stopReason = this.mapStopReason(event.delta.stop_reason);
          }
          if (event.usage) {
            usage.outputTokens = event.usage.output_tokens;
          }
        }
      }

      const durationMs = effectiveEnv.clock.now() - startTime;
      await onEvent({ type: "done", sessionId, usage, durationMs });

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
      const durationMs = effectiveEnv.clock.now() - startTime;
      log.error(
        "[claude-oauth]",
        `Error streaming from Anthropic API: ${error instanceof Error ? error.message : String(error)}`
      );
      await onEvent({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        type: "error",
        result: error instanceof Error ? error.message : String(error),
        sessionId: undefined,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        durationMs,
      };
    }
  }
}
