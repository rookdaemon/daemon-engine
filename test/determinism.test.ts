import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore, SessionMessage } from "../src/session.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import { buildSystemPrompt } from "../src/workspace.js";
import { writeFile } from "node:fs/promises";
import { estimateTokens, splitMessages } from "../src/compaction.js";
import type { Message } from "../src/providers/claude-cli.js";

/**
 * Helper to convert session transcript to messages array.
 * Mirrors the logic in Gateway.buildMessagesArray and Gateway.convertSessionToMessage.
 */
function buildMessagesArray(transcript: SessionMessage[], currentMessage: string): Message[] {
  const messages: Message[] = [];
  
  // Convert existing transcript messages
  for (const sessionMsg of transcript) {
    // Only include user and assistant messages with content
    if ((sessionMsg.role === "user" || sessionMsg.role === "assistant") && sessionMsg.content) {
      messages.push({
        role: sessionMsg.role,
        content: sessionMsg.content,
      });
    }
    // Skip tool messages - they are internal implementation details
  }
  
  // Add current user message
  messages.push({
    role: "user",
    content: currentMessage,
  });
  
  return messages;
}

/**
 * Helper to load JSONL transcript file.
 */
async function loadTranscriptFromFile(filePath: string): Promise<SessionMessage[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n");
  return lines.map((line) => JSON.parse(line) as SessionMessage);
}

describe("Context Determinism", () => {
  let testDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-engine-determinism-test-"));
    store = new FileSessionStore(testDir, createNodeEnvironment());
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Replay Tests", () => {
    it("produces identical messages from same transcript", async () => {
      const transcript = await loadTranscriptFromFile(
        join(import.meta.dirname, "fixtures", "sample-transcript.jsonl")
      );
      
      const currentMessage = "Follow-up question";
      
      const messages1 = buildMessagesArray(transcript, currentMessage);
      const messages2 = buildMessagesArray(transcript, currentMessage);
      
      expect(messages1).toEqual(messages2);
      expect(messages1.length).toBe(messages2.length);
      
      // Verify each message is identical
      for (let i = 0; i < messages1.length; i++) {
        expect(messages1[i].role).toBe(messages2[i].role);
        expect(messages1[i].content).toBe(messages2[i].content);
      }
    });

    it("produces identical messages with various transcript sizes", async () => {
      // Test with 10 messages
      const smallTranscript: SessionMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i + 1}`,
        timestamp: 1706954400000 + i * 1000,
      }));

      const messages1 = buildMessagesArray(smallTranscript, "Current");
      const messages2 = buildMessagesArray(smallTranscript, "Current");
      expect(messages1).toEqual(messages2);

      // Test with 100 messages
      const mediumTranscript: SessionMessage[] = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Message ${i + 1} with some content to make it realistic`,
        timestamp: 1706954400000 + i * 1000,
      }));

      const messages3 = buildMessagesArray(mediumTranscript, "Current");
      const messages4 = buildMessagesArray(mediumTranscript, "Current");
      expect(messages3).toEqual(messages4);
    });

    it("verifies timestamps don't affect message content", async () => {
      // Create two transcripts with same content but different timestamps
      const transcript1: SessionMessage[] = [
        { role: "user", content: "Hello", timestamp: 1000 },
        { role: "assistant", content: "Hi", timestamp: 2000 },
      ];

      const transcript2: SessionMessage[] = [
        { role: "user", content: "Hello", timestamp: 9999999 },
        { role: "assistant", content: "Hi", timestamp: 9999999999 },
      ];

      const messages1 = buildMessagesArray(transcript1, "Follow-up");
      const messages2 = buildMessagesArray(transcript2, "Follow-up");

      // Messages should be identical despite different timestamps
      expect(messages1).toEqual(messages2);
    });

    it("excludes tool messages from messages array", async () => {
      const transcript: SessionMessage[] = [
        { role: "user", content: "Run ls", timestamp: 1000 },
        { role: "assistant", content: null, toolCalls: [{ id: "1", name: "exec", input: { command: "ls" } }], timestamp: 2000 },
        { role: "tool", content: "file1.txt\nfile2.txt", toolCallId: "1", timestamp: 3000 },
        { role: "assistant", content: "I found 2 files", timestamp: 4000 },
      ];

      const messages = buildMessagesArray(transcript, "What else?");

      // Should only include user and assistant messages with content
      expect(messages.length).toBe(3); // user "Run ls", assistant "I found 2 files", user "What else?"
      expect(messages[0].content).toBe("Run ls");
      expect(messages[1].content).toBe("I found 2 files");
      expect(messages[2].content).toBe("What else?");
    });
  });

  describe("Crash Recovery Tests", () => {
    it("reconstructs context after simulated crash", async () => {
      const sessionKey = "agent:test:crash-recovery";

      // Create session and add messages
      await store.append(sessionKey, {
        role: "user",
        content: "First message",
        timestamp: 1000,
      });
      await store.append(sessionKey, {
        role: "assistant",
        content: "First response",
        timestamp: 2000,
      });
      await store.append(sessionKey, {
        role: "user",
        content: "Second message",
        timestamp: 3000,
      });

      // Build messages before "crash"
      const preloadedTranscript = await store.load(sessionKey);
      const messagesBefore = buildMessagesArray(preloadedTranscript, "Third message");

      // Simulate crash: create new store instance (simulating restart)
      const newStore = new FileSessionStore(testDir, createNodeEnvironment());

      // Reload from disk
      const reloadedTranscript = await newStore.load(sessionKey);
      const messagesAfter = buildMessagesArray(reloadedTranscript, "Third message");

      // Verify identical context reconstruction
      expect(messagesAfter).toEqual(messagesBefore);
      expect(messagesAfter.length).toBe(messagesBefore.length);
    });

    it("maintains determinism across multiple crash-reload cycles", async () => {
      const sessionKey = "agent:test:multi-crash";

      // Initial messages
      await store.append(sessionKey, {
        role: "user",
        content: "Message 1",
        timestamp: 1000,
      });
      await store.append(sessionKey, {
        role: "assistant",
        content: "Response 1",
        timestamp: 2000,
      });

      const transcript1 = await store.load(sessionKey);
      const messages1 = buildMessagesArray(transcript1, "Current");

      // Crash and reload #1
      const store2 = new FileSessionStore(testDir, createNodeEnvironment());
      const transcript2 = await store2.load(sessionKey);
      const messages2 = buildMessagesArray(transcript2, "Current");

      // Crash and reload #2
      const store3 = new FileSessionStore(testDir, createNodeEnvironment());
      const transcript3 = await store3.load(sessionKey);
      const messages3 = buildMessagesArray(transcript3, "Current");

      // All should be identical
      expect(messages1).toEqual(messages2);
      expect(messages2).toEqual(messages3);
    });
  });

  describe("Compaction Consistency Tests", () => {
    it("triggers compaction at consistent threshold", () => {
      // Create messages that approach but don't exceed threshold
      const maxTokens = 150000;
      const threshold = maxTokens * 0.8; // 120k tokens

      // Create messages that total just under threshold
      // Each message is ~100 chars = 25 tokens
      const numMessagesUnder = 4790; // 119750 tokens (under threshold)
      const messages: Message[] = Array.from({ length: numMessagesUnder }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(100), // ~25 tokens per message
      }));

      const estimatedTokens = estimateTokens(messages);
      const shouldCompact = estimatedTokens > threshold;

      // Should not trigger compaction yet
      expect(shouldCompact).toBe(false);
      expect(estimatedTokens).toBeLessThan(threshold);

      // Add enough messages to exceed threshold
      for (let i = 0; i < 15; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(100) });
      }
      
      const newEstimatedTokens = estimateTokens(messages);
      const shouldCompactNow = newEstimatedTokens > threshold;

      // Should trigger compaction now
      expect(shouldCompactNow).toBe(true);
      expect(newEstimatedTokens).toBeGreaterThan(threshold);

      // Verify threshold is consistent across multiple checks
      const shouldCompactAgain = estimateTokens(messages) > threshold;
      expect(shouldCompactAgain).toBe(shouldCompactNow);
    });

    it("produces consistent split for same messages", () => {
      const messages: Message[] = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Response 2" },
        { role: "user", content: "Message 3" },
        { role: "assistant", content: "Response 3" },
      ];

      const targetKeepTokens = 10;

      // Split multiple times
      const split1 = splitMessages(messages, targetKeepTokens);
      const split2 = splitMessages(messages, targetKeepTokens);
      const split3 = splitMessages(messages, targetKeepTokens);

      // All splits should be identical
      expect(split1.toKeep).toEqual(split2.toKeep);
      expect(split1.toSummarize).toEqual(split2.toSummarize);
      expect(split2.toKeep).toEqual(split3.toKeep);
      expect(split2.toSummarize).toEqual(split3.toSummarize);

      // Verify order is preserved
      expect([...split1.toSummarize, ...split1.toKeep]).toEqual(messages);
    });

    it("maintains consistent token estimation", () => {
      const message: Message = {
        role: "user",
        content: "This is a test message with consistent content",
      };

      // Estimate tokens multiple times
      const tokens1 = estimateTokens(message);
      const tokens2 = estimateTokens(message);
      const tokens3 = estimateTokens(message);

      // All estimates should be identical
      expect(tokens1).toBe(tokens2);
      expect(tokens2).toBe(tokens3);

      // Test with array
      const messages = [message, message, message];
      const arrayTokens1 = estimateTokens(messages);
      const arrayTokens2 = estimateTokens(messages);

      expect(arrayTokens1).toBe(arrayTokens2);
    });
  });

  describe("System Prompt Tests", () => {
    it("produces identical system prompts from same workspace files", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "daemon-engine-workspace-"));

      try {
        await writeFile(join(workDir, "SOUL.md"), "I am a test daemon.");
        await writeFile(join(workDir, "AGENTS.md"), "Follow instructions.");
        await writeFile(join(workDir, "USER.md"), "The user is a tester.");

        const prompt1 = await buildSystemPrompt(workDir);
        const prompt2 = await buildSystemPrompt(workDir);
        const prompt3 = await buildSystemPrompt(workDir);

        expect(prompt1).toBe(prompt2);
        expect(prompt2).toBe(prompt3);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it("produces different prompts when workspace files change", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "daemon-engine-workspace-"));

      try {
        await writeFile(join(workDir, "SOUL.md"), "Version 1");
        const prompt1 = await buildSystemPrompt(workDir);

        await writeFile(join(workDir, "SOUL.md"), "Version 2");
        const prompt2 = await buildSystemPrompt(workDir);

        expect(prompt1).not.toBe(prompt2);
        expect(prompt1).toContain("Version 1");
        expect(prompt2).toContain("Version 2");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it("verifies file ordering is consistent", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "daemon-engine-workspace-"));

      try {
        // Write files in non-alphabetical order
        await writeFile(join(workDir, "USER.md"), "User file");
        await writeFile(join(workDir, "AGENTS.md"), "Agents file");
        await writeFile(join(workDir, "SOUL.md"), "Soul file");

        const prompt1 = await buildSystemPrompt(workDir);
        const prompt2 = await buildSystemPrompt(workDir);

        // Prompts should be identical
        expect(prompt1).toBe(prompt2);

        // Verify ordering is preserved (AGENTS.md should come before SOUL.md in OpenClaw order)
        const agentsIndex = prompt1.indexOf("## AGENTS.md");
        const soulIndex = prompt1.indexOf("## SOUL.md");
        const userIndex = prompt1.indexOf("## USER.md");

        expect(agentsIndex).toBeGreaterThan(-1);
        expect(soulIndex).toBeGreaterThan(agentsIndex);
        expect(userIndex).toBeGreaterThan(soulIndex);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it("handles missing files consistently", async () => {
      const workDir = await mkdtemp(join(tmpdir(), "daemon-engine-workspace-"));

      try {
        // Only create one file, rest should be marked [MISSING]
        await writeFile(join(workDir, "SOUL.md"), "Only soul");

        const prompt1 = await buildSystemPrompt(workDir);
        const prompt2 = await buildSystemPrompt(workDir);

        expect(prompt1).toBe(prompt2);
        expect(prompt1).toContain("[MISSING]");
        expect(prompt1).toContain("Only soul");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
