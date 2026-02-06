/**
 * context-limits.ts — Model-specific context window limits and thresholds.
 *
 * Defines context limits for different Claude models and provides utilities
 * for checking if context is approaching limits.
 */

/**
 * Context window limits for Claude models (in tokens).
 * 
 * These are the maximum context windows as of 2024. The limits include
 * both input and output tokens combined.
 */
export const MODEL_LIMITS: Record<string, number> = {
  // Claude 3.5 Sonnet
  "claude-3-5-sonnet-20241022": 200000,
  "claude-3-5-sonnet-20240620": 200000,
  "sonnet": 200000, // Alias for latest Sonnet
  
  // Claude 3 Opus
  "claude-3-opus-20240229": 200000,
  "opus": 200000, // Alias for latest Opus
  
  // Claude 3 Haiku
  "claude-3-haiku-20240307": 200000,
  "haiku": 200000, // Alias for latest Haiku
  
  // Default fallback for unknown models
  "default": 200000,
};

/**
 * Default threshold for triggering compaction (as a fraction of context limit).
 * 
 * At 0.75 (75%), we trigger compaction to leave room for the response
 * and avoid hitting the hard limit.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.75;

/**
 * Get the context limit for a specific model.
 * 
 * @param model - Model identifier (e.g., "sonnet", "claude-3-5-sonnet-20241022")
 * @returns Context limit in tokens
 */
export function getContextLimit(model: string): number {
  return MODEL_LIMITS[model] || MODEL_LIMITS.default;
}

/**
 * Get the compaction threshold for a model (75% of context limit by default).
 * 
 * @param model - Model identifier
 * @param fraction - Optional threshold fraction (default: 0.75)
 * @returns Token count threshold for triggering compaction
 */
export function getCompactionThreshold(model: string, fraction: number = DEFAULT_COMPACTION_THRESHOLD): number {
  return Math.floor(getContextLimit(model) * fraction);
}

/**
 * Check if token count exceeds the compaction threshold.
 * 
 * @param tokenCount - Current token count
 * @param model - Model identifier
 * @param threshold - Optional custom threshold fraction
 * @returns True if compaction should be triggered
 */
export function shouldCompact(tokenCount: number, model: string, threshold?: number): boolean {
  return tokenCount >= getCompactionThreshold(model, threshold);
}

/**
 * Check if token count is approaching the hard context limit.
 * 
 * @param tokenCount - Current token count
 * @param model - Model identifier
 * @returns True if within 95% of hard limit (danger zone)
 */
export function isNearLimit(tokenCount: number, model: string): boolean {
  const limit = getContextLimit(model);
  return tokenCount >= limit * 0.95;
}
