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
        fetch: mockFetch,
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
});
