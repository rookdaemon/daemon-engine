import { describe, it, expect } from "vitest";
import { estimateTokens, estimateSystemPromptTokens, estimateTotalTokens } from "../src/messages.js";
import type { Message } from "../src/providers/claude-cli.js";

describe("estimateTokens", () => {
  it("returns 0 for empty messages array", () => {
    const tokens = estimateTokens([]);
    expect(tokens).toBe(0);
  });

  it("estimates tokens for a single user message", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
    ];
    const tokens = estimateTokens(messages);
    // "Hello" = 5 chars + 10 overhead = 15 chars / 4 = 3.75 -> ceil to 4
    expect(tokens).toBe(4);
  });

  it("estimates tokens for multiple messages", () => {
    const messages: Message[] = [
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: "I cannot check the weather." },
      { role: "user", content: "OK" },
    ];
    const tokens = estimateTokens(messages);
    // Message 1: 20 chars + 10 = 30
    // Message 2: 27 chars + 10 = 37
    // Message 3: 2 chars + 10 = 12
    // Total: 79 / 4 = 19.75 -> ceil to 20
    expect(tokens).toBe(20);
  });

  it("uses chars/4 heuristic consistently", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(100) },
    ];
    const tokens = estimateTokens(messages);
    // 100 chars + 10 overhead = 110 / 4 = 27.5 -> ceil to 28
    expect(tokens).toBe(28);
  });

  it("handles long messages", () => {
    const longText = "This is a long message. ".repeat(100); // ~2400 chars
    const messages: Message[] = [
      { role: "user", content: longText },
    ];
    const tokens = estimateTokens(messages);
    // Should be roughly (2400 + 10) / 4 = 602.5 -> ceil to 603
    expect(tokens).toBeGreaterThan(600);
    expect(tokens).toBeLessThan(650);
  });

  it("handles empty content", () => {
    const messages: Message[] = [
      { role: "user", content: "" },
    ];
    const tokens = estimateTokens(messages);
    // 0 chars + 10 overhead = 10 / 4 = 2.5 -> ceil to 3
    expect(tokens).toBe(3);
  });

  it("handles mixed roles", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "system", content: "Test" },
    ];
    const tokens = estimateTokens(messages);
    // Message 1: 5 + 10 = 15
    // Message 2: 2 + 10 = 12
    // Message 3: 4 + 10 = 14
    // Total: 41 / 4 = 10.25 -> ceil to 11
    expect(tokens).toBe(11);
  });
});

describe("estimateSystemPromptTokens", () => {
  it("estimates tokens for system prompt", () => {
    const tokens = estimateSystemPromptTokens("You are a helpful assistant.");
    // 28 chars + 20 overhead = 48 / 4 = 12
    expect(tokens).toBe(12);
  });

  it("handles empty system prompt", () => {
    const tokens = estimateSystemPromptTokens("");
    // 0 chars + 20 overhead = 20 / 4 = 5
    expect(tokens).toBe(5);
  });

  it("handles long system prompt", () => {
    const longPrompt = "x".repeat(1000);
    const tokens = estimateSystemPromptTokens(longPrompt);
    // 1000 + 20 = 1020 / 4 = 255
    expect(tokens).toBe(255);
  });
});

describe("estimateTotalTokens", () => {
  it("combines message and system prompt estimates", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
    ];
    const systemPrompt = "You are helpful.";
    const tokens = estimateTotalTokens(messages, systemPrompt);
    
    // Messages: (5 + 10) / 4 = 3.75 -> 4
    // System: (16 + 20) / 4 = 9
    // Total: 13
    expect(tokens).toBe(13);
  });

  it("handles empty messages with system prompt", () => {
    const messages: Message[] = [];
    const systemPrompt = "Test";
    const tokens = estimateTotalTokens(messages, systemPrompt);
    
    // Messages: 0
    // System: (4 + 20) / 4 = 6
    expect(tokens).toBe(6);
  });

  it("handles complex conversation", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(100) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(50) },
    ];
    const systemPrompt = "a".repeat(500);
    const tokens = estimateTotalTokens(messages, systemPrompt);
    
    // Messages: (100+10 + 200+10 + 50+10) / 4 = 380/4 = 95
    // System: (500 + 20) / 4 = 130
    // Total: 225
    expect(tokens).toBe(225);
  });
});
