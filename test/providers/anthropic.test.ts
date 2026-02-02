import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    provider = new AnthropicProvider({ apiKey: "test-api-key" });
  });

  it("maps messages correctly to Anthropic format", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
      }),
    });

    await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-api-key",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        }),
      })
    );

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.model).toBe("claude-3-5-sonnet-20241022");
    expect(callBody.system).toBe("You are a helpful assistant.");
    expect(callBody.messages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("parses text response correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "This is a response." }],
        stop_reason: "end_turn",
      }),
    });

    const response = await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(response.content).toBe("This is a response.");
    expect(response.stopReason).toBe("end");
    expect(response.toolCalls).toBeUndefined();
  });

  it("parses tool_use response with arguments", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Let me search for that." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "web_search",
            input: { query: "weather today" },
          },
        ],
        stop_reason: "tool_use",
      }),
    });

    const response = await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
        },
      ],
    });

    expect(response.content).toBe("Let me search for that.");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "web_search",
        input: { query: "weather today" },
      },
    ]);
  });

  it("handles multiple tool calls in response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "search",
            input: { query: "test" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "read",
            input: { path: "/test.txt" },
          },
        ],
        stop_reason: "tool_use",
      }),
    });

    const response = await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "System",
      messages: [{ role: "user", content: "Do stuff" }],
      tools: [
        {
          name: "search",
          description: "Search",
          input_schema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "read",
          description: "Read",
          input_schema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls?.[0].name).toBe("search");
    expect(response.toolCalls?.[1].name).toBe("read");
  });

  it("passes system prompt correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      }),
    });

    await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "You are a daemon agent.",
      messages: [{ role: "user", content: "Test" }],
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.system).toBe("You are a daemon agent.");
  });

  it("includes tools in request when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      }),
    });

    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
        },
      },
    ];

    await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "System",
      messages: [{ role: "user", content: "Read test.txt" }],
      tools,
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.tools).toEqual(tools);
  });

  it("handles API authentication errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      }),
    });

    await expect(
      provider.chat({
        model: "claude-3-5-sonnet-20241022",
        system: "System",
        messages: [{ role: "user", content: "Test" }],
      })
    ).rejects.toThrow("Anthropic API error (401): Invalid API key");
  });

  it("handles rate limit errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Rate limit exceeded",
        },
      }),
    });

    await expect(
      provider.chat({
        model: "claude-3-5-sonnet-20241022",
        system: "System",
        messages: [{ role: "user", content: "Test" }],
      })
    ).rejects.toThrow("Anthropic API error (429): Rate limit exceeded");
  });

  it("handles network failures", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    await expect(
      provider.chat({
        model: "claude-3-5-sonnet-20241022",
        system: "System",
        messages: [{ role: "user", content: "Test" }],
      })
    ).rejects.toThrow("Network error");
  });

  it("handles API errors without error message", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    await expect(
      provider.chat({
        model: "claude-3-5-sonnet-20241022",
        system: "System",
        messages: [{ role: "user", content: "Test" }],
      })
    ).rejects.toThrow("Anthropic API error (500): Internal Server Error");
  });

  it("uses API key from environment variable when not provided in config", () => {
    process.env.ANTHROPIC_API_KEY = "env-api-key";
    const envProvider = new AnthropicProvider();

    expect(envProvider).toBeDefined();
    // The API key will be used in the actual request
  });

  it("throws error when no API key is available", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new AnthropicProvider()).toThrow(
      "Anthropic API key is required. Provide it in config or set ANTHROPIC_API_KEY environment variable."
    );
  });

  it("prefers config API key over environment variable", async () => {
    process.env.ANTHROPIC_API_KEY = "env-api-key";
    const configProvider = new AnthropicProvider({ apiKey: "config-api-key" });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      }),
    });

    await configProvider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "System",
      messages: [{ role: "user", content: "Test" }],
    });

    const callHeaders = fetchMock.mock.calls[0][1].headers;
    expect(callHeaders["x-api-key"]).toBe("config-api-key");
  });

  it("handles empty content array in response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: "end_turn",
      }),
    });

    const response = await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "System",
      messages: [{ role: "user", content: "Test" }],
    });

    expect(response.content).toBe("");
    expect(response.stopReason).toBe("end");
  });

  it("concatenates multiple text blocks in response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "First part. " },
          { type: "text", text: "Second part." },
        ],
        stop_reason: "end_turn",
      }),
    });

    const response = await provider.chat({
      model: "claude-3-5-sonnet-20241022",
      system: "System",
      messages: [{ role: "user", content: "Test" }],
    });

    expect(response.content).toBe("First part. Second part.");
  });
});
