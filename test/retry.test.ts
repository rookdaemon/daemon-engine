import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isTransientError, DEFAULT_RETRY_CONFIG, RetryConfig, parseRetryAfter } from "../src/retry.js";
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
      // Create a date 10 seconds in the future
      const futureDate = new Date(Date.now() + 10000);
      const httpDate = futureDate.toUTCString();
      const result = parseRetryAfter(httpDate);
      
      // Should be approximately 10 seconds (allow 1 second tolerance for test execution time)
      expect(result).toBeGreaterThanOrEqual(9);
      expect(result).toBeLessThanOrEqual(10);
    });

    it("returns 0 for past HTTP-date", () => {
      const pastDate = new Date(Date.now() - 5000);
      const httpDate = pastDate.toUTCString();
      const result = parseRetryAfter(httpDate);
      
      // Should return 0 (max of 0 and negative seconds)
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
      const operation = vi.fn();
      
      // First call: error with retryAfterSeconds
      interface ErrorWithRetryMetadata extends Error {
        retryAfterSeconds?: number;
      }
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 5;
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      
      // Second call: success
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000, // Would normally use this
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const result = await withRetry(operation, config, "[test]", mockEnv);
      const elapsed = Date.now() - startTime;
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      
      // Should wait approximately 5 seconds (5000ms), not 1 second
      expect(elapsed).toBeGreaterThanOrEqual(4900);
      expect(elapsed).toBeLessThanOrEqual(5200);
    }, 10000); // Increase timeout to 10 seconds

    it("caps Retry-After at maxDelayMs", async () => {
      const operation = vi.fn();
      
      // First call: error with large retryAfterSeconds
      interface ErrorWithRetryMetadata extends Error {
        retryAfterSeconds?: number;
      }
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 120; // 2 minutes
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      
      // Second call: success
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000, // Cap at 10 seconds
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const result = await withRetry(operation, config, "[test]", mockEnv);
      const elapsed = Date.now() - startTime;
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      
      // Should wait 10 seconds (capped), not 120 seconds
      expect(elapsed).toBeGreaterThanOrEqual(9900);
      expect(elapsed).toBeLessThanOrEqual(10200);
    }, 15000); // Increase timeout to 15 seconds

    it("falls back to exponential backoff if retryAfterSeconds is 0", async () => {
      const operation = vi.fn();
      
      // First call: error with retryAfterSeconds = 0 (invalid)
      interface ErrorWithRetryMetadata extends Error {
        retryAfterSeconds?: number;
      }
      const errorWithRetryAfter = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      errorWithRetryAfter.retryAfterSeconds = 0;
      operation.mockRejectedValueOnce(errorWithRetryAfter);
      
      // Second call: success
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      };

      const startTime = Date.now();
      const result = await withRetry(operation, config, "[test]", mockEnv);
      const elapsed = Date.now() - startTime;
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(2);
      
      // Should wait minimal time (0ms from retryAfterSeconds)
      expect(elapsed).toBeLessThanOrEqual(100);
    });

    it("does not apply exponential backoff when using Retry-After", async () => {
      const operation = vi.fn();
      
      interface ErrorWithRetryMetadata extends Error {
        retryAfterSeconds?: number;
      }
      
      // First call: error with retryAfterSeconds
      const error1 = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      error1.retryAfterSeconds = 1;
      operation.mockRejectedValueOnce(error1);
      
      // Second call: error with retryAfterSeconds again
      const error2 = new Error("429 Rate limit") as ErrorWithRetryMetadata;
      error2.retryAfterSeconds = 1;
      operation.mockRejectedValueOnce(error2);
      
      // Third call: success
      operation.mockResolvedValueOnce("success");

      const config: RetryConfig = {
        enabled: true,
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 60000,
        backoffMultiplier: 2, // Should not be applied
      };

      const startTime = Date.now();
      const result = await withRetry(operation, config, "[test]", mockEnv);
      const elapsed = Date.now() - startTime;
      
      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(3);
      
      // Should wait ~2 seconds total (1s + 1s), not exponential (1s + 2s)
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      expect(elapsed).toBeLessThanOrEqual(2200);
    });
  });
});
