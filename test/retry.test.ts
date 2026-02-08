import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isTransientError, DEFAULT_RETRY_CONFIG, RetryConfig, parseRetryAfter, ErrorWithRetryMetadata } from "../src/retry.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { Environment } from "../src/env/environment.js";

describe("retry", () => {
  let mockEnv: Environment;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createNodeEnvironment();
  });

  describe("parseRetryAfter", () => {
    it("parses integer seconds format", () => {
      expect(parseRetryAfter("5")).toBe(5);
      expect(parseRetryAfter("60")).toBe(60);
      expect(parseRetryAfter("3600")).toBe(3600);
    });

    it("parses HTTP-date format", () => {
      const nowMs = 1000000000000; // Fixed timestamp for determinism
      const futureDate = new Date(nowMs + 10000);
      const httpDate = futureDate.toUTCString();
      const result = parseRetryAfter(httpDate, nowMs);
      expect(result).toBe(10);
    });

    it("returns 0 for past HTTP-date", () => {
      const nowMs = 1000000000000;
      const pastDate = new Date(nowMs - 5000);
      const httpDate = pastDate.toUTCString();
      const result = parseRetryAfter(httpDate, nowMs);
      expect(result).toBe(0);
    });

    it("returns 0 for invalid format", () => {
      expect(parseRetryAfter("invalid")).toBe(0);
      expect(parseRetryAfter("")).toBe(0);
      expect(parseRetryAfter("abc123")).toBe(0);
    });
  });

  describe("isTransientError", () => {
    it("returns true for 429 rate limit errors", () => {
      const error = new Error("Gemini API error 429: Rate limit exceeded");
      expect(isTransientError(error)).toBe(true);
    });

    it("returns true for 503 service unavailable errors", () => {
      const error = new Error("Gemini API error 503: Service Unavailable");
      expect(isTransientError(error)).toBe(true);
    });

    it("returns true for 500 internal server errors", () => {
      const error = new Error("API error 500: Internal Server Error");
      expect(isTransientError(error)).toBe(true);
    });

    it("returns false for intentional timeout errors", () => {
      const error = new Error("Request timeout after 30000ms");
      expect(isTransientError(error)).toBe(false); // Our own timeout should not retry
    });

    it("returns true for network timeout errors", () => {
      const error = new Error("Network request failed: ETIMEDOUT");
      expect(isTransientError(error)).toBe(true);
    });

    it("returns true for network errors", () => {
      const error = new Error("Network error: ECONNRESET");
      expect(isTransientError(error)).toBe(true);
    });

    it("returns false for non-transient errors", () => {
      const error = new Error("Invalid API key");
      expect(isTransientError(error)).toBe(false);
    });

    it("returns false for non-Error objects", () => {
      expect(isTransientError("string error")).toBe(false);
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("succeeds on first attempt", async () => {
      const operation = vi.fn().mockResolvedValue("success");
      const result = await withRetry(operation, DEFAULT_RETRY_CONFIG, "[test]", mockEnv);
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("retries on transient error and succeeds", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("API error 429: Rate limit"))
        .mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 10, // Short delay for testing
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };

      const result = await withRetry(operation, config, "[test]", mockEnv);
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries multiple times with exponential backoff", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("503 Service Unavailable"))
        .mockRejectedValueOnce(new Error("503 Service Unavailable"))
        .mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
      };

      const result = await withRetry(operation, config, "[test]", mockEnv);
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting retries", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("429 Rate limit"));

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };

      await expect(
        withRetry(operation, config, "[test]", mockEnv)
      ).rejects.toThrow("429 Rate limit");
      
      // Should try initial + 2 retries = 3 total attempts
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it("does not retry on non-transient errors", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("Invalid API key"));

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };

      await expect(
        withRetry(operation, config, "[test]", mockEnv)
      ).rejects.toThrow("Invalid API key");
      
      // Should only try once since it's not a transient error
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not retry when disabled", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("429 Rate limit"));

      const config: RetryConfig = {
        enabled: false,
        maxAttempts: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2,
      };

      await expect(
        withRetry(operation, config, "[test]", mockEnv)
      ).rejects.toThrow("429 Rate limit");
      
      // Should only try once since retry is disabled
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("respects maxDelayMs cap", async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error("503"))
        .mockRejectedValueOnce(new Error("503"))
        .mockRejectedValueOnce(new Error("503"))
        .mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 150, // Cap lower than what backoff would reach
        backoffMultiplier: 2,
      };

      const result = await withRetry(operation, config, "[test]", mockEnv);
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(4);
    });

    it("uses Retry-After timing from error", async () => {
      vi.useFakeTimers();
      const clockEnv: Environment = {
        ...mockEnv,
        clock: { now: () => Date.now() },
      };

      const operation = vi.fn();
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 5;
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const resultPromise = withRetry(operation, config, "[test]", clockEnv);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;
      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(elapsed).toBe(5000);

      vi.useRealTimers();
    });

    it("caps Retry-After at maxDelayMs", async () => {
      vi.useFakeTimers();
      const clockEnv: Environment = {
        ...mockEnv,
        clock: { now: () => Date.now() },
      };

      const operation = vi.fn();
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 120;
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const resultPromise = withRetry(operation, config, "[test]", clockEnv);
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;
      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(elapsed).toBe(10000);

      vi.useRealTimers();
    });

    it("falls back to exponential backoff if retryAfterSeconds is 0", async () => {
      vi.useFakeTimers();
      const clockEnv: Environment = {
        ...mockEnv,
        clock: { now: () => Date.now() },
      };

      const operation = vi.fn();
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 0;
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const resultPromise = withRetry(operation, config, "[test]", clockEnv);
      await vi.advanceTimersByTimeAsync(100); // sleep uses Max(0, delay-5) so ~0ms
      const result = await resultPromise;
      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeLessThanOrEqual(100);

      vi.useRealTimers();
    });

    it("does not apply exponential backoff when using Retry-After", async () => {
      vi.useFakeTimers();
      const clockEnv: Environment = {
        ...mockEnv,
        clock: { now: () => Date.now() },
      };

      const operation = vi.fn();
      const error1 = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      error1.retryAfterSeconds = 1;
      operation.mockRejectedValueOnce(error1);
      const error2 = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      error2.retryAfterSeconds = 1;
      operation.mockRejectedValueOnce(error2);
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const resultPromise = withRetry(operation, config, "[test]", clockEnv);
      await vi.advanceTimersByTimeAsync(2000); // 1s + 1s
      const result = await resultPromise;
      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(3);
      expect(elapsed).toBe(2000);

      vi.useRealTimers();
    });
  });
});
