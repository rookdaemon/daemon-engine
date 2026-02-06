import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry, isTransientError, DEFAULT_RETRY_CONFIG, RetryConfig } from "../src/retry.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { Environment } from "../src/env/environment.js";

describe("retry", () => {
  let mockEnv: Environment;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createNodeEnvironment();
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
  });
});
