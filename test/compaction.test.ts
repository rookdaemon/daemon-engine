import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  splitMessages,
  buildSummaryPrompt,
  compactContext,
} from "../src/compaction.js";
import type { Message } from "../src/providers/claude-cli.js";

describe("compaction", () => {
  describe("estimateTokens", () => {
    it("estimates tokens for a simple string", () => {
      // "Hello world" is 11 characters, so roughly 3 tokens
      const tokens = estimateTokens("Hello world");
      expect(tokens).toBe(3); // 11 / 4 = 2.75, ceil = 3
    });

    it("estimates tokens for a longer string", () => {
      const text = "This is a longer sentence with more words and characters.";
      const tokens = estimateTokens(text);
      // 58 characters / 4 = 14.5, ceil = 15
      expect(tokens).toBe(15);
    });

    it("estimates tokens for a single message", () => {
      const message: Message = {
        role: "user",
        content: "Hello, how are you?",
      };
      const tokens = estimateTokens(message);
      // 19 characters / 4 = 4.75, ceil = 5
      expect(tokens).toBe(5);
    });

    it("estimates tokens for an array of messages", () => {
      const messages: Message[] = [
        { role: "user", content: "Hello" }, // 5 chars
        { role: "assistant", content: "Hi there!" }, // 9 chars
      ];
      const tokens = estimateTokens(messages);
      // 14 characters / 4 = 3.5, ceil = 4
      expect(tokens).toBe(4);
    });

    it("handles empty string", () => {
      const tokens = estimateTokens("");
      expect(tokens).toBe(0);
    });

    it("handles empty array", () => {
      const tokens = estimateTokens([]);
      expect(tokens).toBe(0);
    });
  });

  describe("splitMessages", () => {
    it("splits messages keeping recent ones", () => {
      const messages: Message[] = [
        { role: "user", content: "Message 1" }, // 9 chars = 3 tokens
        { role: "assistant", content: "Response 1" }, // 10 chars = 3 tokens
        { role: "user", content: "Message 2" }, // 9 chars = 3 tokens
        { role: "assistant", content: "Response 2" }, // 10 chars = 3 tokens
        { role: "user", content: "Message 3" }, // 9 chars = 3 tokens
      ];

      const result = splitMessages(messages, 7); // Keep ~7 tokens (last 2-3 messages)

      expect(result.toSummarize.length).toBeGreaterThan(0);
      expect(result.toKeep.length).toBeGreaterThan(0);
      expect(result.toSummarize.length + result.toKeep.length).toBe(messages.length);
      
      // Verify order is preserved
      expect([...result.toSummarize, ...result.toKeep]).toEqual(messages);
    });

    it("keeps all messages if token limit is high", () => {
      const messages: Message[] = [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
      ];

      const result = splitMessages(messages, 10000);

      expect(result.toSummarize).toEqual([]);
      expect(result.toKeep).toEqual(messages);
    });

    it("keeps at least the last message", () => {
      const messages: Message[] = [
        { role: "user", content: "Very long message that exceeds token limit but should still be kept as it's the only message. ".repeat(100) },
      ];

      const result = splitMessages(messages, 10); // Very low limit

      expect(result.toSummarize).toEqual([]);
      expect(result.toKeep).toEqual(messages);
    });

    it("preserves system messages in toKeep", () => {
      const messages: Message[] = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
      ];

      const result = splitMessages(messages, 7);

      // System message should always be in toKeep
      expect(result.toKeep[0]).toEqual({ role: "system", content: "You are a helpful assistant" });
      expect(result.toSummarize.some((m) => m.role === "system")).toBe(false);
    });

    it("handles multiple system messages", () => {
      const messages: Message[] = [
        { role: "system", content: "System 1" },
        { role: "system", content: "System 2" },
        { role: "user", content: "User message" },
      ];

      const result = splitMessages(messages, 5);

      expect(result.toKeep.filter((m) => m.role === "system")).toHaveLength(2);
    });

    it("handles empty messages array", () => {
      const result = splitMessages([], 100);

      expect(result.toKeep).toEqual([]);
      expect(result.toSummarize).toEqual([]);
    });

    it("handles only system messages", () => {
      const messages: Message[] = [
        { role: "system", content: "System message" },
      ];

      const result = splitMessages(messages, 10);

      expect(result.toKeep).toEqual(messages);
      expect(result.toSummarize).toEqual([]);
    });
  });

  describe("buildSummaryPrompt", () => {
    it("builds a prompt for initial summarization", () => {
      const messages: Message[] = [
        { role: "user", content: "What is TypeScript?" },
        { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
      ];

      const prompt = buildSummaryPrompt(messages);

      expect(prompt).toContain("CONVERSATION TO SUMMARIZE:");
      expect(prompt).toContain("User: What is TypeScript?");
      expect(prompt).toContain("Assistant: TypeScript is a typed superset of JavaScript.");
      expect(prompt).toContain("## Goal");
      expect(prompt).toContain("## Progress");
      expect(prompt).toContain("## Key Decisions");
      expect(prompt).toContain("## Next Steps");
      expect(prompt).toContain("## Critical Context");
    });

    it("includes existing summary for iterative compaction", () => {
      const existingSummary = `## Goal
Learn about TypeScript

## Progress
### Done
- [x] Asked about TypeScript basics

### In Progress
- [ ] Understanding advanced features`;

      const messages: Message[] = [
        { role: "user", content: "Tell me about generics" },
        { role: "assistant", content: "Generics allow you to write reusable code." },
      ];

      const prompt = buildSummaryPrompt(messages, existingSummary);

      expect(prompt).toContain("PREVIOUS SUMMARY");
      expect(prompt).toContain(existingSummary);
      expect(prompt).toContain("ADDITIONAL CONVERSATION TO INCORPORATE");
      expect(prompt).toContain("User: Tell me about generics");
      expect(prompt).toContain("Integrate information from both the PREVIOUS SUMMARY and the ADDITIONAL CONVERSATION");
    });

    it("formats messages correctly", () => {
      const messages: Message[] = [
        { role: "user", content: "First" },
        { role: "assistant", content: "Second" },
        { role: "user", content: "Third" },
      ];

      const prompt = buildSummaryPrompt(messages);

      expect(prompt).toContain("User: First");
      expect(prompt).toContain("Assistant: Second");
      expect(prompt).toContain("User: Third");
    });

    it("handles empty messages array", () => {
      const prompt = buildSummaryPrompt([]);

      expect(prompt).toContain("CONVERSATION TO SUMMARIZE:");
      expect(prompt).toContain("## Goal");
    });
  });

  describe("compactContext", () => {
    it("compacts context and generates summary", async () => {
      const messages: Message[] = [
        { role: "user", content: "Message 1 with some content" },
        { role: "assistant", content: "Response 1 with some content" },
        { role: "user", content: "Message 2 with some content" },
        { role: "assistant", content: "Response 2 with some content" },
        { role: "user", content: "Current message" },
      ];

      const mockLlm = async (prompt: string): Promise<string> => {
        expect(prompt).toContain("CONVERSATION TO SUMMARIZE:");
        return `## Goal
Test compaction

## Progress
### Done
- [x] Sent messages 1-4

### In Progress
- [ ] Processing current message

## Key Decisions
- **Decision**: Use compaction
  - Rationale: Context too large

## Next Steps
1. Continue conversation
2. Monitor token usage

## Critical Context
- User is testing the compaction feature
- Previous messages discussed various topics`;
      };

      const result = await compactContext(messages, 15, "sonnet", mockLlm);

      expect(result.messagesCompacted).toBeGreaterThan(0);
      expect(result.messagesKept.length).toBeGreaterThan(0);
      expect(result.summary).toContain("## Goal");
      expect(result.summary).toContain("## Progress");
      expect(result.summaryTokens).toBeGreaterThan(0);
    });

    it("handles no compaction needed", async () => {
      const messages: Message[] = [
        { role: "user", content: "Short" },
      ];

      const mockLlm = async (): Promise<string> => {
        throw new Error("Should not be called");
      };

      const result = await compactContext(messages, 10000, "sonnet", mockLlm);

      expect(result.messagesCompacted).toBe(0);
      expect(result.messagesKept).toEqual(messages);
      expect(result.summary).toBe("");
      expect(result.summaryTokens).toBe(0);
    });

    it("detects existing summary for iterative compaction", async () => {
      const existingSummary = `## Goal
Previous goal

## Progress
### Done
- [x] Previous work`;

      const messages: Message[] = [
        { role: "system", content: existingSummary },
        { role: "user", content: "Old message 1" },
        { role: "assistant", content: "Old response 1" },
        { role: "user", content: "Recent message" },
      ];

      let capturedPrompt = "";
      const mockLlm = async (prompt: string): Promise<string> => {
        capturedPrompt = prompt;
        return `## Goal
Updated goal`;
      };

      await compactContext(messages, 10, "sonnet", mockLlm);

      expect(capturedPrompt).toContain("PREVIOUS SUMMARY");
      expect(capturedPrompt).toContain(existingSummary);
    });

    it("throws error when LLM fails", async () => {
      const messages: Message[] = [
        { role: "user", content: "Message 1" },
        { role: "user", content: "Message 2" },
        { role: "user", content: "Message 3" },
      ];

      const mockLlm = async (): Promise<string> => {
        throw new Error("LLM error");
      };

      await expect(
        compactContext(messages, 5, "sonnet", mockLlm)
      ).rejects.toThrow("Compaction failed: LLM error");
    });

    it("preserves message order in result", async () => {
      const messages: Message[] = [
        { role: "user", content: "A" },
        { role: "assistant", content: "B" },
        { role: "user", content: "C" },
        { role: "assistant", content: "D" },
        { role: "user", content: "E" },
      ];

      const mockLlm = async (): Promise<string> => "## Goal\nTest";

      const result = await compactContext(messages, 3, "sonnet", mockLlm);

      // Last few messages should be kept in order
      expect(result.messagesKept[result.messagesKept.length - 1]).toEqual({ role: "user", content: "E" });
    });

    it("handles system messages correctly", async () => {
      const messages: Message[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Old message" },
        { role: "assistant", content: "Old response" },
        { role: "user", content: "Recent message" },
      ];

      const mockLlm = async (): Promise<string> => "## Goal\nTest";

      const result = await compactContext(messages, 10, "sonnet", mockLlm);

      // System message should be in toKeep
      expect(result.messagesKept[0].role).toBe("system");
    });
  });
});
