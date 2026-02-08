/**
 * gemini.ts — Gemini API provider for daemon-engine.
 *
 * Implements the LlmProvider interface for Google's Gemini models.
 * 
 * Retry behavior:
 * - Automatically retries on transient errors (429, 503, 500, network errors)
 * - Exponential backoff: 1s initial delay, 2x multiplier, max 60s delay
 * - Configurable via retry config (enabled, maxAttempts, delays)
 * - Default: 5 retry attempts with retry enabled
 */

import { LlmProvider, ProviderRequest, ProviderResponse, StreamEvent, Usage, Message, ToolDefinitionLike, ToolCall } from "./types.js";
import { Environment } from "../env/environment.js";
import { log } from "../logger.js";
import { withRetry, DEFAULT_RETRY_CONFIG, RetryConfig, parseRetryAfter, ErrorWithRetryMetadata } from "../retry.js";
import { randomUUID } from "node:crypto";

interface GeminiConfig {
  apiKey: string;
  model?: string; // e.g. "gemini-1.5-pro-latest"
  retry?: RetryConfig;
}

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

export class GeminiProvider implements LlmProvider {
  private config: GeminiConfig;
  private baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(config: GeminiConfig) {
    this.config = config;
  }

  /**
   * Convert internal Message format to Gemini Content format.
   */
  private convertMessages(messages: Message[]): GeminiContent[] {
    // Gemini doesn't support "system" role in contents (it uses systemInstruction).
    // It also strictly alternates user/model.
    // We assume the upstream logic handles compaction/cleaning, but we filter out system messages here just in case.
    
    return messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));
  }

  /**
   * Convert ToolDefinitionLike to Gemini FunctionDeclaration format.
   */
  private convertToolDefinitions(toolDefinitions: ToolDefinitionLike[]): GeminiTool[] {
    if (!toolDefinitions || toolDefinitions.length === 0) {
      return [];
    }

    const functionDeclarations: GeminiFunctionDeclaration[] = toolDefinitions.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    return [{ functionDeclarations }];
  }

  /**
   * Extract tool calls from Gemini response.
   */
  private extractToolCalls(response: {
    candidates?: Array<{ 
      content?: { 
        parts?: Array<{ 
          text?: string; 
          functionCall?: { name: string; args: unknown } 
        }> 
      };
      finishReason?: string;
    }>;
  }): { toolCalls: ToolCall[]; stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" } {
    const toolCalls: ToolCall[] = [];
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | undefined;

    const candidate = response.candidates?.[0];
    if (!candidate) {
      return { toolCalls, stopReason: "end_turn" };
    }

    // Check finish reason
    const finishReason = candidate.finishReason;
    if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    } else if (finishReason === "STOP") {
      stopReason = "end_turn";
    }

    // Extract function calls from parts
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${randomUUID()}`, // Generate unique ID
          name: part.functionCall.name,
          input: part.functionCall.args,
        });
      }
    }

    // If we have tool calls, set stop reason to tool_use
    if (toolCalls.length > 0) {
      stopReason = "tool_use";
    }

    return { toolCalls, stopReason };
  }

  /**
   * Handle error response and check for Retry-After header on 429 status.
   */
  private handleErrorResponse(response: Response, errorText: string, env: Environment): Error {
    // Log all headers on 429 for debugging
    if (response.status === 429) {
      const headers: Record<string, string> = {};
      if (response.headers && typeof response.headers.forEach === "function") {
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (response.headers && typeof response.headers.get === "function") {
        const retryAfter = response.headers.get("Retry-After");
        if (retryAfter !== null) {
          headers["retry-after"] = retryAfter;
        }
      }
      log.info("[gemini]", `429 response headers: ${JSON.stringify(headers)}`);
      log.info("[gemini]", `429 response body: ${errorText}`);
    }
    
    // Check for Retry-After header on 429
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const waitSeconds = parseRetryAfter(retryAfter, env.clock.now());
        log.info('[gemini]', `Rate limited. Retry-After: ${waitSeconds}s`);
        
        // Attach metadata to error for retry logic to use
        const error = new Error(`Gemini API error ${response.status}: ${errorText}`) as ErrorWithRetryMetadata;
        error.retryAfterSeconds = waitSeconds;
        return error;
      }
    }
    
    return new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  async generate(
    request: ProviderRequest,
    env: Environment
  ): Promise<ProviderResponse> {
    const model = request.model || this.config.model || "gemini-1.5-flash";
    log.info('[gemini]', `Config has retry: ${!!this.config.retry}, value: ${JSON.stringify(this.config.retry)}`);
    const retryConfig = this.config.retry 
      ? { ...DEFAULT_RETRY_CONFIG, ...this.config.retry }
      : DEFAULT_RETRY_CONFIG;
    log.info('[gemini]', `Using retry config: initialDelayMs=${retryConfig.initialDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}`);
    const startTime = env.clock.now();

    const geminiBody: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      systemInstruction: {
        parts: [{ text: request.systemPrompt }]
      }
    };

    // Add tool definitions if provided
    if (request.toolDefinitions && request.toolDefinitions.length > 0) {
      geminiBody.tools = this.convertToolDefinitions(request.toolDefinitions);
      log.info('[gemini]', `Added ${request.toolDefinitions.length} tool definition(s)`);
    }

    try {
      log.info("[gemini]", `Request [model=${model}]: ${JSON.stringify(geminiBody.contents.slice(-1))}`);

      // Execute with retry on transient errors
      const result = await withRetry(
        async () => {
          const url = `${this.baseUrl}/${model}:generateContent?key=${this.config.apiKey}`;
          const response = await env.http.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(geminiBody)
          });

          if (!response.ok) {
            const errorText = await response.text();
            
            throw this.handleErrorResponse(response, errorText, env);
          }

          return await response.json() as {
            candidates?: Array<{ 
              content?: { 
                parts?: Array<{ 
                  text?: string;
                  functionCall?: { name: string; args: unknown };
                }> 
              };
              finishReason?: string;
            }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          };
        },
        retryConfig,
        "[gemini]",
        env
      );

      const durationMs = env.clock.now() - startTime;

      // Extract tool calls and stop reason
      const { toolCalls, stopReason } = this.extractToolCalls(result);

      // Extract text from parts that aren't function calls
      const textParts: string[] = [];
      const parts = result.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          textParts.push(part.text);
        }
      }
      const resultText = textParts.join("");
      
      // Usage stats
      const usage: Usage = {
        inputTokens: result.usageMetadata?.promptTokenCount || 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount || 0,
        cacheReadTokens: 0, // Gemini doesn't report cache hits in this API version yet?
        costUsd: 0 // We'd need a pricing table to calculate this
      };

      const response: ProviderResponse = {
        type: "success",
        result: resultText,
        usage,
        durationMs,
        sessionId: "", // Stateless API
        stopReason,
      };

      // Add tool calls if present
      if (toolCalls.length > 0) {
        response.toolCalls = toolCalls;
        log.info('[gemini]', `Extracted ${toolCalls.length} tool call(s)`);
      }

      return response;

    } catch (error) {
      return {
        type: "error",
        result: error instanceof Error ? error.message : String(error),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        durationMs: env.clock.now() - startTime
      };
    }
  }

  async generateStream(
    request: ProviderRequest,
    onEvent: (event: StreamEvent) => void | Promise<void>,
    env: Environment
  ): Promise<ProviderResponse> {
    const model = request.model || this.config.model || "gemini-1.5-flash";
    const retryConfig = this.config.retry 
      ? { ...DEFAULT_RETRY_CONFIG, ...this.config.retry }
      : DEFAULT_RETRY_CONFIG;
    log.info('[gemini]', `Using retry config (stream): initialDelayMs=${retryConfig.initialDelayMs}, maxDelayMs=${retryConfig.maxDelayMs}`);
    const startTime = env.clock.now();

    const geminiBody: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      systemInstruction: {
        parts: [{ text: request.systemPrompt }]
      }
    };

    // Add tool definitions if provided
    if (request.toolDefinitions && request.toolDefinitions.length > 0) {
      geminiBody.tools = this.convertToolDefinitions(request.toolDefinitions);
      log.info('[gemini]', `Added ${request.toolDefinitions.length} tool definition(s) to stream request`);
    }

    try {
      log.info("[gemini]", `Streaming Request [model=${model}]`);

      // Execute initial connection with retry, but not the streaming itself
      // Once streaming starts, we don't retry mid-stream to avoid duplicate tokens
      const streamResponse = await withRetry(
        async () => {
          const url = `${this.baseUrl}/${model}:streamGenerateContent?key=${this.config.apiKey}&alt=sse`;
          const response = await env.http.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(geminiBody)
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw this.handleErrorResponse(response, errorText, env);
          }

          if (!response.body) throw new Error("No response body");

          return response;
        },
        retryConfig,
        "[gemini]",
        env
      );

      // Now stream the response without retry (already connected)
      let completeResult = "";
      let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
      const toolCalls: ToolCall[] = [];
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | undefined;

      // Simple SSE parser
      // Node's native fetch response body is a ReadableStream
      // We need to read from it.
      
      // In Node 22+ with native fetch, response.body is a Web ReadableStream.
      // We can iterate it.
      if (!streamResponse.body) throw new Error("No response body");
      
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6);
            if (jsonStr === "[DONE]") continue; // Standard SSE done signal

            try {
              const chunk = JSON.parse(jsonStr);
              
              // Extract parts from the chunk
              const parts = chunk.candidates?.[0]?.content?.parts || [];
              
              for (const part of parts) {
                // Handle text delta
                if (part.text) {
                  completeResult += part.text;
                  await onEvent({ type: "token", text: part.text });
                }
                
                // Handle function calls
                if (part.functionCall) {
                  const toolCall: ToolCall = {
                    id: `call_${randomUUID()}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args,
                  };
                  toolCalls.push(toolCall);
                  
                  await onEvent({
                    type: "tool_call",
                    id: toolCall.id,
                    name: toolCall.name,
                    input: toolCall.input,
                  });
                }
              }
              
              // Check finish reason
              const finishReason = chunk.candidates?.[0]?.finishReason;
              if (finishReason === "MAX_TOKENS") {
                stopReason = "max_tokens";
              } else if (finishReason === "STOP") {
                stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
              }

              // Extract usage from the final chunk usually
              if (chunk.usageMetadata) {
                usage.inputTokens = chunk.usageMetadata.promptTokenCount;
                usage.outputTokens = chunk.usageMetadata.candidatesTokenCount;
              }

            } catch {
              // Ignore parse errors on malformed chunks
            }
          }
        }
      }

      const durationMs = env.clock.now() - startTime;
      
      await onEvent({ 
        type: "done", 
        usage, 
        durationMs 
      });

      const response: ProviderResponse = {
        type: "success",
        result: completeResult,
        usage,
        durationMs,
        stopReason,
      };

      // Add tool calls if present
      if (toolCalls.length > 0) {
        response.toolCalls = toolCalls;
        log.info('[gemini]', `Stream extracted ${toolCalls.length} tool call(s)`);
      }

      return response;

    } catch (error) {
       const msg = error instanceof Error ? error.message : String(error);
       await onEvent({ type: "error", message: msg });
       return {
         type: "error",
         result: msg,
         usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
         durationMs: env.clock.now() - startTime
       };
    }
  }
}
