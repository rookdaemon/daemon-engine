/**
 * retry.ts — Retry utilities with exponential backoff for LLM provider calls.
 *
 * Implements configurable retry logic for handling transient errors from LLM APIs.
 */

import { log } from "./logger.js";
import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Whether retry is enabled. If false, operations fail immediately. */
  enabled: boolean;
  /** Maximum number of retry attempts (excluding the initial attempt). */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelayMs: number;
  /** Maximum delay in milliseconds between retries. */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (typically 2). */
  backoffMultiplier: number;
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  enabled: true,
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
};

/**
 * Sleep for a specified duration.
 */
async function sleep(ms: number, env: Environment): Promise<void> {
  return new Promise((resolve) => {
    env.process.setTimeout(resolve, ms);
  });
}

/**
 * Pattern for detecting intentional timeout errors from our own timeout mechanism.
 * Used to prevent retrying on timeouts we initiated ourselves.
 */
const INTENTIONAL_TIMEOUT_PATTERN = "cli timeout after";

/**
 * Check if an error is transient and should be retried.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Don't retry on intentional timeout cancellations from our own code
  if (message.includes(INTENTIONAL_TIMEOUT_PATTERN)) {
    return false;
  }

  // Check for HTTP status codes that should trigger retry
  if (message.includes("429") || message.includes("rate limit")) {
    return true;
  }
  if (message.includes("503") || message.includes("service unavailable")) {
    return true;
  }
  if (message.includes("500") || message.includes("internal server error")) {
    return true;
  }

  // Check for network/timeout errors (but not our own timeout)
  if (
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout")
  ) {
    return true;
  }

  return false;
}

/**
 * Execute an operation with retry and exponential backoff.
 *
 * @param operation - Async function to execute with retry
 * @param config - Retry configuration
 * @param context - Context string for logging (e.g., "[gemini]")
 * @param env - Environment for clock access
 * @returns Result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  context: string,
  env: Environment = createNodeEnvironment()
): Promise<T> {
  if (!config.enabled) {
    // Retry disabled, execute once without retry
    return await operation();
  }

  let lastError: unknown;
  let delay = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if this is a transient error worth retrying
      if (!isTransientError(error)) {
        throw error;
      }

      // Check if we have retries left
      if (attempt >= config.maxAttempts) {
        log.error(
          context,
          `All ${config.maxAttempts} retry attempts exhausted. Last error: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
      }

      // Calculate delay for this retry (with exponential backoff)
      const currentDelay = Math.min(delay, config.maxDelayMs);
      
      log.info(
        context,
        `Transient error detected (attempt ${attempt + 1}/${config.maxAttempts + 1}). Retrying in ${currentDelay}ms. Error: ${error instanceof Error ? error.message : String(error)}`
      );

      // Wait before retrying
      await sleep(currentDelay, env);

      // Increase delay for next retry
      delay *= config.backoffMultiplier;
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
