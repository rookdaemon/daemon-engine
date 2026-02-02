/**
 * anthropic.ts — Anthropic Messages API provider.
 *
 * Implements the LLMProvider interface for the Anthropic Messages API.
 * Uses native fetch (no SDK dependencies) to call the API and map between
 * our Message format and Anthropic's expected format.
 */

/** A message in a conversation. */
export interface Message {
  role: string;
  content: string;
}

/** Definition of a tool that the LLM can call. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** A tool call returned by the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Response from an LLM chat completion. */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason: "end" | "tool_use";
}

/** Parameters for the LLM chat method. */
export interface ChatParams {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

/** LLM provider interface. */
export interface LLMProvider {
  chat(params: ChatParams): Promise<LLMResponse>;
}

/** Configuration for AnthropicProvider. */
export interface AnthropicConfig {
  apiKey?: string;
}

/** Content block in Anthropic API response. */
interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** Anthropic API response. */
interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
}

/** Anthropic API error response. */
interface AnthropicErrorResponse {
  type: string;
  error?: {
    type: string;
    message: string;
  };
}

/**
 * Anthropic Messages API provider.
 *
 * Implements LLMProvider interface for calling Anthropic's Messages API.
 * Supports text responses and tool use. API key can be provided via config
 * or the ANTHROPIC_API_KEY environment variable.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly apiUrl = "https://api.anthropic.com/v1/messages";
  private readonly apiVersion = "2023-06-01";

  /**
   * Create a new Anthropic provider.
   *
   * @param config - Configuration object with optional API key.
   * @throws Error if no API key is provided and ANTHROPIC_API_KEY env var is not set.
   */
  constructor(config?: AnthropicConfig) {
    this.apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error(
        "Anthropic API key is required. Provide it in config or set ANTHROPIC_API_KEY environment variable."
      );
    }
  }

  /**
   * Call Anthropic Messages API with the given parameters.
   *
   * @param params - Chat parameters including model, system prompt, messages, and tools.
   * @returns LLM response with content, optional tool calls, and stop reason.
   * @throws Error on API errors (auth, rate limit, network failures).
   */
  async chat(params: ChatParams): Promise<LLMResponse> {
    const requestBody = {
      model: params.model,
      max_tokens: 4096,
      system: params.system,
      messages: params.messages,
      ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
    };

    try {
      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as AnthropicErrorResponse;
        const errorMessage =
          errorData.error?.message ?? response.statusText;
        throw new Error(
          `Anthropic API error (${response.status}): ${errorMessage}`
        );
      }

      const data = (await response.json()) as AnthropicResponse;
      return this.parseResponse(data);
    } catch (error) {
      // Re-throw our own errors and network errors
      throw error;
    }
  }

  /**
   * Parse Anthropic API response into our LLMResponse format.
   *
   * Extracts text content from text blocks and tool calls from tool_use blocks.
   * Maps stop_reason to our format ('end' or 'tool_use').
   *
   * @param data - Raw Anthropic API response.
   * @returns Parsed LLM response.
   */
  private parseResponse(data: AnthropicResponse): LLMResponse {
    const textBlocks: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        textBlocks.push(block.text);
      } else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      }
    }

    const content = textBlocks.join("");
    const stopReason = data.stop_reason === "tool_use" ? "tool_use" : "end";

    return {
      content,
      stopReason,
      ...(toolCalls.length > 0 && { toolCalls }),
    };
  }
}
