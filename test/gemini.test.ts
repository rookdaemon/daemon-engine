import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("GeminiProvider with retry", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockEnv: Environment;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    const baseEnv = createNodeEnvironment();
    mockEnv = {
      ...baseEnv,
      http: {
        ...baseEnv.http,
        fetch: mockFetch as unknown as typeof fetch,
      },
      clock: {
        now: () => Date.now(),
      },
    };
  });

  it("succeeds on first attempt without retry", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Hello!" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Say hello" }],
      systemPrompt: "You are helpful",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.result).toBe("Hello!");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
      retry: {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      },
    });

    // First call: 429 error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: () => null, // No Retry-After header
      },
      text: async () => "Rate limit exceeded",
    });

    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Success after retry!" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "You are helpful",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.result).toBe("Success after retry!");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 service unavailable", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fails after exhausting retries", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      },
    });

    // All attempts fail with 429
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: {
        get: () => null, // No Retry-After header
      },
      text: async () => "Rate limit exceeded",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("error");
    expect(response.result).toContain("429");
    // Initial attempt + 2 retries = 3 total
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 400 bad request", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("error");
    expect(response.result).toContain("400");
    // Should only try once (400 is not transient)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("respects disabled retry config", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: false,
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limit",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("error");
    // Should only try once since retry is disabled
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("uses default retry config when not specified", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      // No retry config specified - should use DEFAULT_RETRY_CONFIG
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service unavailable",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    // Should have retried since default config has retry enabled
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("respects Retry-After header on 429 with integer seconds", async () => {
    vi.useFakeTimers();
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => name === 'Retry-After' ? "5" : null,
      },
      text: async () => "Rate limit exceeded",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Success!" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const startTime = Date.now();
    const responsePromise = provider.generate(request, mockEnv);
    await vi.advanceTimersByTimeAsync(5000);
    const response = await responsePromise;
    const elapsed = Date.now() - startTime;

    expect(response.type).toBe("success");
    expect(response.result).toBe("Success!");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBe(5000);

    vi.useRealTimers();
  });

  it("respects Retry-After header on 429 with HTTP-date format", async () => {
    vi.useFakeTimers();
    const nowMs = 1000000000000;
    vi.setSystemTime(nowMs);
    const futureDate = new Date(nowMs + 3000);
    const httpDate = futureDate.toUTCString();

    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => name === 'Retry-After' ? httpDate : null,
      },
      text: async () => "Rate limit exceeded",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Success!" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const startTime = Date.now();
    const responsePromise = provider.generate(request, mockEnv);
    await vi.advanceTimersByTimeAsync(3000);
    const response = await responsePromise;
    const elapsed = Date.now() - startTime;

    expect(response.type).toBe("success");
    expect(response.result).toBe("Success!");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBe(3000);

    vi.useRealTimers();
  });

  it("falls back to exponential backoff when 429 has no Retry-After header", async () => {
    vi.useFakeTimers();
    const provider = new GeminiProvider({
      apiKey: "test-key",
      retry: {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      },
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => "Rate limit exceeded",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Success!" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "Test",
    };

    const startTime = Date.now();
    const responsePromise = provider.generate(request, mockEnv);
    await vi.advanceTimersByTimeAsync(100);
    const response = await responsePromise;
    const elapsed = Date.now() - startTime;

    expect(response.type).toBe("success");
    expect(response.result).toBe("Success!");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThanOrEqual(200);

    vi.useRealTimers();
  });
});

describe("GeminiProvider with tool calling", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockEnv: Environment;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    const baseEnv = createNodeEnvironment();
    mockEnv = {
      ...baseEnv,
      http: {
        ...baseEnv.http,
        fetch: mockFetch as unknown as typeof fetch,
      },
      clock: {
        now: () => Date.now(),
      },
    };
  });

  it("sends tool definitions in request", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "I'll use the multiply tool" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "What is 5 times 3?" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "multiply",
          description: "Multiply two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number", description: "First number" },
              b: { type: "number", description: "Second number" },
            },
            required: ["a", "b"],
          },
        },
      ],
    };

    await provider.generate(request, mockEnv);

    // Verify tool definitions were sent in the request
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    
    expect(requestBody.tools).toBeDefined();
    expect(requestBody.tools).toHaveLength(1);
    expect(requestBody.tools[0].functionDeclarations).toBeDefined();
    expect(requestBody.tools[0].functionDeclarations[0].name).toBe("multiply");
    expect(requestBody.tools[0].functionDeclarations[0].description).toBe("Multiply two numbers");
    expect(requestBody.tools[0].functionDeclarations[0].parameters.type).toBe("object");
  });

  it("extracts tool calls from response", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "multiply",
                    args: { a: 5, b: 3 },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "What is 5 times 3?" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "multiply",
          description: "Multiply two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    
    // Assert toolCalls is defined before accessing
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].name).toBe("multiply");
    expect(response.toolCalls[0].input).toEqual({ a: 5, b: 3 });
    expect(response.toolCalls[0].id).toBeDefined();
  });

  it("handles multiple tool calls", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "add",
                    args: { a: 5, b: 3 },
                  },
                },
                {
                  functionCall: {
                    name: "multiply",
                    args: { a: 2, b: 4 },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Calculate" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "add",
          description: "Add two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
        {
          name: "multiply",
          description: "Multiply two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toHaveLength(2);
    
    // Assert toolCalls is defined before accessing
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].name).toBe("add");
    expect(response.toolCalls[1].name).toBe("multiply");
  });

  it("handles response with both text and tool calls", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "Let me calculate that for you.",
                },
                {
                  functionCall: {
                    name: "multiply",
                    args: { a: 5, b: 3 },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "What is 5 times 3?" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "multiply",
          description: "Multiply two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.result).toBe("Let me calculate that for you.");
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toHaveLength(1);
    
    // Assert toolCalls is defined before accessing
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].name).toBe("multiply");
  });
});
