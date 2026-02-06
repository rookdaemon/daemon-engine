/**
 * messages.ts — Message manipulation and token estimation utilities.
 *
 * Provides utilities for working with message arrays, including token
 * estimation for context window management.
 */

import type { Message } from "./providers/claude-cli.js";

/**
 * Estimate token count for an array of messages.
 * 
 * Uses a simple heuristic of characters/4 as a baseline approximation.
 * This is less accurate than tiktoken but sufficient for threshold checks.
 * 
 * @param messages - Array of messages to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  
  for (const message of messages) {
    // Count characters in content
    totalChars += message.content.length;
    
    // Add overhead for role and structure (~10 chars per message for JSON formatting)
    totalChars += 10;
  }
  
  // Use chars/4 heuristic for token estimation
  // This tends to slightly overestimate, which is safer for threshold checks
  return Math.ceil(totalChars / 4);
}

/**
 * Estimate token count for a system prompt string.
 * 
 * @param systemPrompt - System prompt text
 * @returns Estimated token count
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  // System prompt with overhead
  return Math.ceil((systemPrompt.length + 20) / 4);
}

/**
 * Estimate total token count for a complete request (messages + system prompt).
 * 
 * @param messages - Array of messages
 * @param systemPrompt - System prompt text
 * @returns Estimated total input token count
 */
export function estimateTotalTokens(messages: Message[], systemPrompt: string): number {
  return estimateTokens(messages) + estimateSystemPromptTokens(systemPrompt);
}
