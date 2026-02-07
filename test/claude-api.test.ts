import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeApiProvider } from "../src/providers/claude-api.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("ClaudeApiProvider", () => {
  let mockEnv: Environment;
  let mockCreate: ReturnType<typeof vi.fn>;
  let mockClaudeApi: ClaudeApiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    
    const baseEnv = createNodeEnvironment();
    mockEnv = {
      ...baseEnv,
      clock: {
        now: () => Date.now(),
      },
    };

    // Create a mock for the Anthropic client
    mockCreate = vi.fn();
    
    // Create the provider and inject the mock
    mockClaudeApi = new ClaudeApiProvider({
      apiKey: "test-key",
      model: "claude-3-5-sonnet-20241022",
    });
    
    // Replace the client's messages.create method with our mock
    (mockClaudeApi as unknown as { client: { messages: { create: typeof mockCreate } } }).client.messages.create = mockCreate;
  });

  it("successfully generates a response", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello, world!" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Say hello" }],
      systemPrompt: "You are a helpful assistant.",
    };

    const response = await mockClaudeApi.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.result).toBe("Hello, world!");
    expect(response.sessionId).toBe("msg_123");
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.stopReason).toBe("end_turn");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("handles tool calls correctly", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_456",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_abc123",
          name: "get_weather",
          input: { location: "San Francisco" },
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 50,
        output_tokens: 25,
      },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "What's the weather?" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "get_weather",
          description: "Get weather information",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      ],
    };

    const response = await mockClaudeApi.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].id).toBe("tool_abc123");
    expect(response.toolCalls[0].name).toBe("get_weather");
    expect(response.toolCalls[0].input).toEqual({ location: "San Francisco" });
  });

  it("converts tool definitions to Anthropic format", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "msg_789",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "I'll help" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Calculate 2+2" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "calculate",
          description: "Perform a calculation",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string" },
            },
            required: ["expression"],
          },
        },
      ],
    };

    await mockClaudeApi.generate(request, mockEnv);

    // Verify the tool was passed in Anthropic format
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools[0]).toEqual({
      name: "calculate",
      description: "Perform a calculation",
      input_schema: {
        type: "object",
        properties: {
          expression: { type: "string" },
        },
        required: ["expression"],
      },
    });
  });

  it("handles errors gracefully", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "You are helpful",
    };

    const response = await mockClaudeApi.generate(request, mockEnv);

    expect(response.type).toBe("error");
    expect(response.result).toContain("API error");
  });

  it("uses custom model when specified", async () => {
    const customProvider = new ClaudeApiProvider({
      apiKey: "test-key",
      model: "claude-3-opus-20240229",
    });
    
    const customMockCreate = vi.fn();
    (customProvider as unknown as { client: { messages: { create: typeof customMockCreate } } }).client.messages.create = customMockCreate;

    customMockCreate.mockResolvedValueOnce({
      id: "msg_custom",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Custom model response" }],
      model: "claude-3-opus-20240229",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 5,
        output_tokens: 3,
      },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "You are helpful",
    };

    await customProvider.generate(request, mockEnv);

    // Verify the correct model was used
    const callArgs = customMockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-3-opus-20240229");
  });
});
