/**
 * compaction.ts — Context compaction with structured summarization.
 *
 * This module implements context compaction that summarizes old messages
 * while preserving recent context and critical state information.
 */

import type { Message } from "./providers/claude-cli.js";
import { log } from "./logger.js";

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** The generated summary of compacted messages. */
  summary: string;
  /** Messages that were kept (most recent). */
  messagesKept: Message[];
  /** Number of messages that were compacted into the summary. */
  messagesCompacted: number;
  /** Estimated tokens in the summary. */
  summaryTokens: number;
}

/**
 * Estimate the number of tokens in a message or string.
 * 
 * Uses a simple heuristic: ~4 characters per token (approximation based on
 * common tokenization patterns). This is intentionally conservative.
 * 
 * @param content - Message or string to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(content: Message[] | Message | string): number {
  let text: string;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // For message arrays, sum up all content
    text = content.map((m) => m.content).join("");
  } else {
    // Single message
    text = content.content;
  }

  // Rough estimate: 1 token ≈ 4 characters
  // This is conservative for English text (usually closer to 3-3.5)
  return Math.ceil(text.length / 4);
}

/**
 * Split messages into those to keep (recent) and those to summarize (old).
 * 
 * Always preserves system messages at the start. Keeps the most recent
 * ~keepTokens worth of messages, and returns the rest for summarization.
 * 
 * @param messages - All messages in the conversation
 * @param keepTokens - Target number of tokens to keep (approximately)
 * @returns Split messages: toKeep (recent) and toSummarize (old)
 */
export function splitMessages(
  messages: Message[],
  keepTokens: number
): { toKeep: Message[]; toSummarize: Message[] } {
  if (messages.length === 0) {
    return { toKeep: [], toSummarize: [] };
  }

  // Separate system messages (always keep) from conversation messages
  const systemMessages: Message[] = [];
  const conversationMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      conversationMessages.push(msg);
    }
  }

  // If no conversation messages, nothing to compact
  if (conversationMessages.length === 0) {
    return { toKeep: systemMessages, toSummarize: [] };
  }

  // Walk backwards from the end, accumulating tokens until we exceed keepTokens
  let accumulatedTokens = 0;
  let keepCount = 0;

  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(conversationMessages[i]);
    accumulatedTokens += msgTokens;

    if (accumulatedTokens > keepTokens && keepCount > 0) {
      // We've exceeded the limit and have at least one message to keep
      break;
    }

    keepCount++;
  }

  // Ensure we keep at least the last message (the current one)
  if (keepCount === 0 && conversationMessages.length > 0) {
    keepCount = 1;
  }

  const splitIndex = conversationMessages.length - keepCount;
  const toSummarize = conversationMessages.slice(0, splitIndex);
  const toKeepConversation = conversationMessages.slice(splitIndex);

  return {
    toKeep: [...systemMessages, ...toKeepConversation],
    toSummarize,
  };
}

/**
 * Build a prompt for the LLM to summarize messages.
 * 
 * The prompt instructs the LLM to create a structured summary following
 * a specific format with sections for Goal, Progress, Key Decisions,
 * Next Steps, and Critical Context.
 * 
 * @param messagesToSummarize - Messages to include in the summary
 * @param existingSummary - Optional previous summary (for iterative compaction)
 * @returns Prompt string for the LLM
 */
export function buildSummaryPrompt(
  messagesToSummarize: Message[],
  existingSummary?: string
): string {
  let prompt = `You are tasked with creating a concise, structured summary of a conversation.

`;

  if (existingSummary) {
    prompt += `PREVIOUS SUMMARY (from earlier in the conversation):
${existingSummary}

ADDITIONAL CONVERSATION TO INCORPORATE:
`;
  } else {
    prompt += `CONVERSATION TO SUMMARIZE:
`;
  }

  // Format messages as conversation
  for (const msg of messagesToSummarize) {
    const roleName = msg.role === "user" ? "User" : "Assistant";
    prompt += `\n${roleName}: ${msg.content}\n`;
  }

  prompt += `

Generate a structured summary following this EXACT format:

## Goal
<What the user is trying to accomplish>

## Progress
### Done
- [x] <Completed item>
- [x] <Completed item>

### In Progress
- [ ] <Current work>

## Key Decisions
- **Decision**: <What was decided>
  - Rationale: <Why>

## Next Steps
1. <Immediate next action>
2. <Following action>

## Critical Context
- <Important context that must not be lost>
- <Technical decisions, constraints, etc.>

IMPORTANT: 
- Follow the format exactly as shown above
- Be concise but preserve critical information
- Include all major decisions and their rationale
- Capture what was accomplished and what remains
`;

  if (existingSummary) {
    prompt += `- Integrate information from both the PREVIOUS SUMMARY and the ADDITIONAL CONVERSATION
- The summary should be a complete, standalone document
`;
  }

  return prompt;
}

/**
 * Compact context by summarizing old messages.
 * 
 * This function:
 * 1. Splits messages into recent (keep) and old (summarize)
 * 2. Generates a structured summary of old messages using an LLM
 * 3. Returns the summary, kept messages, and metadata
 * 
 * @param messages - All messages to potentially compact
 * @param targetTokens - Target token count to keep as recent context
 * @param model - Model name for the LLM call (for logging/metadata)
 * @param callLlm - Function to call the LLM with a prompt
 * @returns Compaction result with summary and kept messages
 */
export async function compactContext(
  messages: Message[],
  targetTokens: number,
  model: string,
  callLlm: (prompt: string) => Promise<string>
): Promise<CompactionResult> {
  // Split messages
  const { toKeep, toSummarize } = splitMessages(messages, targetTokens);

  // If nothing to summarize, return early
  if (toSummarize.length === 0) {
    return {
      summary: "",
      messagesKept: toKeep,
      messagesCompacted: 0,
      summaryTokens: 0,
    };
  }

  // Check if there's an existing summary in system messages
  let existingSummary: string | undefined;
  for (const msg of messages) {
    if (msg.role === "system" && msg.content.includes("## Goal")) {
      // This looks like a previous compaction summary
      existingSummary = msg.content;
      break;
    }
  }

  // Build summary prompt
  const prompt = buildSummaryPrompt(toSummarize, existingSummary);

  // Call LLM to generate summary
  let summary: string;
  try {
    summary = await callLlm(prompt);
  } catch (error) {
    // If summarization fails, we should not compact
    // Log the error and return uncompacted messages
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("[compaction]", `Failed to generate summary: ${errorMsg}`);
    throw new Error(`Compaction failed: ${errorMsg}`);
  }

  // Estimate tokens in the summary
  const summaryTokens = estimateTokens(summary);

  return {
    summary,
    messagesKept: toKeep,
    messagesCompacted: toSummarize.length,
    summaryTokens,
  };
}
