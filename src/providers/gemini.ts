/**
 * gemini.ts — Gemini API provider for daemon-engine.
 *
 * Implements the LlmProvider interface for Google's Gemini models.
 */

import { LlmProvider, ProviderRequest, ProviderResponse, StreamEvent, Usage, Message } from "./types.js";
import { Environment } from "../env/environment.js";
import { log } from "../logger.js";
import { withRetry, DEFAULT_RETRY_CONFIG, RetryConfig } from "../retry.js";

interface GeminiConfig {
  apiKey: string;
  model?: string; // e.g. "gemini-1.5-pro-latest"
  retry?: RetryConfig;
}

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: { text: string }[];
  };
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

  async generate(
    request: ProviderRequest,
    env: Environment
  ): Promise<ProviderResponse> {
    const model = request.model || this.config.model || "gemini-1.5-flash";
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;
    const startTime = env.clock.now();

    const geminiBody: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      systemInstruction: {
        parts: [{ text: request.systemPrompt }]
      }
    };

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
            throw new Error(`Gemini API error ${response.status}: ${errorText}`);
          }

          return await response.json() as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
          };
        },
        retryConfig,
        "[gemini]",
        env
      );

      const durationMs = env.clock.now() - startTime;

      // Extract text
      const resultText = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      // Usage stats
      const usage: Usage = {
        inputTokens: result.usageMetadata?.promptTokenCount || 0,
        outputTokens: result.usageMetadata?.candidatesTokenCount || 0,
        cacheReadTokens: 0, // Gemini doesn't report cache hits in this API version yet?
        costUsd: 0 // We'd need a pricing table to calculate this
      };

      return {
        type: "success",
        result: resultText,
        usage,
        durationMs,
        sessionId: "" // Stateless API
      };

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
    const retryConfig = this.config.retry || DEFAULT_RETRY_CONFIG;
    const startTime = env.clock.now();

    const geminiBody: GeminiRequest = {
      contents: this.convertMessages(request.messages),
      systemInstruction: {
        parts: [{ text: request.systemPrompt }]
      }
    };

    let completeResult = "";
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };

    try {
      log.info("[gemini]", `Streaming Request [model=${model}]`);

      // Execute with retry on transient errors
      await withRetry(
        async () => {
          const url = `${this.baseUrl}/${model}:streamGenerateContent?key=${this.config.apiKey}&alt=sse`;
          const response = await env.http.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(geminiBody)
          });

          if (!response.ok) {
            throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
          }

          if (!response.body) throw new Error("No response body");

          // Simple SSE parser
          // Node's native fetch response body is a ReadableStream
          // We need to read from it.
          
          // In Node 22+ with native fetch, response.body is a Web ReadableStream.
          // We can iterate it.
          const reader = response.body.getReader();
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
                  
                  // Extract content delta
                  const textDelta = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (textDelta) {
                    completeResult += textDelta;
                    await onEvent({ type: "token", text: textDelta });
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
        },
        retryConfig,
        "[gemini]",
        env
      );

      const durationMs = env.clock.now() - startTime;
      
      await onEvent({ 
        type: "done", 
        usage, 
        durationMs 
      });

      return {
        type: "success",
        result: completeResult,
        usage,
        durationMs
      };

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
