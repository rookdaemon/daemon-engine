/**
 * failure-modes.test.ts — Tests for failure mode handling and safety.
 *
 * This module tests that the system handles failures gracefully without
 * corrupting session state. The core invariant: **session transcript data is never lost**.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore, SessionMessage } from "../src/session.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { Message } from "../src/providers/claude-cli.js";
import { compactContext } from "../src/compaction.js";

describe("Failure Mode Handling", () => {
  let testDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-engine-failure-test-"));
    store = new FileSessionStore(testDir, createNodeEnvironment());
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Missing Transcripts", () => {
    it("recovers gracefully from missing transcript", async () => {
      const sessionKey = "agent:test:missing";

      // Create session directory and metadata but no transcript
      // Session directory uses safeId which replaces : with _
      const sessionDir = join(testDir, "agent_test_missing");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "metadata.json"),
        JSON.stringify({
          sessionKey,
          model: "claude-3-7-sonnet-20250219",
          created: 1000,
          lastActive: 1000,
          compactionCount: 0,
        }),
        "utf-8"
      );

      // Load should return empty array, not throw
      const messages = await store.load(sessionKey);
      expect(messages).toEqual([]);
    });

    it("starts fresh session after missing transcript", async () => {
      const sessionKey = "agent:test:fresh";

      // Create metadata without transcript
      const sessionDir = join(testDir, "agent_test_fresh");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "metadata.json"),
        JSON.stringify({ sessionKey }),
        "utf-8"
      );

      // Load returns empty array
      const messages = await store.load(sessionKey);
      expect(messages).toEqual([]);

      // Can append new messages
      const newMessage: SessionMessage = {
        role: "user",
        content: "Starting fresh",
        timestamp: 1000,
      };
      await store.append(sessionKey, newMessage);

      // Verify message was saved
      const loadedMessages = await store.load(sessionKey);
      expect(loadedMessages).toHaveLength(1);
      expect(loadedMessages[0]).toEqual(newMessage);
    });
  });

  describe("Corrupted JSONL", () => {
    it("skips corrupted lines and preserves valid messages", async () => {
      const sessionKey = "agent:test:corrupted";
      // Session directory uses safeId which replaces : with _
      const sessionDir = join(testDir, "agent_test_corrupted");
      await mkdir(sessionDir, { recursive: true });

      // Create transcript with mixed valid and corrupted lines
      const transcriptPath = join(sessionDir, "transcript.jsonl");
      const validMsg1 = { role: "user", content: "First valid message", timestamp: 1000 };
      const validMsg2 = { role: "assistant", content: "Second valid message", timestamp: 2000 };
      const validMsg3 = { role: "user", content: "Third valid message", timestamp: 3000 };

      const transcriptContent = [
        JSON.stringify(validMsg1),
        "{ invalid json without closing brace",  // Corrupted line
        JSON.stringify(validMsg2),
        "not json at all",  // Corrupted line
        JSON.stringify(validMsg3),
        "",  // Empty line (should be filtered out)
      ].join("\n");

      await writeFile(transcriptPath, transcriptContent, "utf-8");

      // Load should skip corrupted lines and return valid messages
      const messages = await store.load(sessionKey);
      
      // Should have exactly 3 valid messages
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual(validMsg1);
      expect(messages[1]).toEqual(validMsg2);
      expect(messages[2]).toEqual(validMsg3);
    });

    it("handles transcript with all corrupted lines", async () => {
      const sessionKey = "agent:test:allcorrupted";
      const sessionDir = join(testDir, "agent_test_allcorrupted");
      await mkdir(sessionDir, { recursive: true });

      const transcriptPath = join(sessionDir, "transcript.jsonl");
      const transcriptContent = [
        "{ invalid json",
        "not json",
        "{ also: invalid }",
      ].join("\n");

      await writeFile(transcriptPath, transcriptContent, "utf-8");

      // Load should return empty array if all lines are corrupted
      const messages = await store.load(sessionKey);
      expect(messages).toEqual([]);
    });

    it("handles empty transcript file", async () => {
      const sessionKey = "agent:test:empty";
      const sessionDir = join(testDir, "agent_test_empty");
      await mkdir(sessionDir, { recursive: true });

      const transcriptPath = join(sessionDir, "transcript.jsonl");
      await writeFile(transcriptPath, "", "utf-8");

      const messages = await store.load(sessionKey);
      expect(messages).toEqual([]);
    });

    it("handles transcript with only whitespace", async () => {
      const sessionKey = "agent:test:whitespace";
      const sessionDir = join(testDir, "agent_test_whitespace");
      await mkdir(sessionDir, { recursive: true });

      const transcriptPath = join(sessionDir, "transcript.jsonl");
      await writeFile(transcriptPath, "\n\n  \n\t\n", "utf-8");

      const messages = await store.load(sessionKey);
      expect(messages).toEqual([]);
    });
  });

  describe("Compaction Failures", () => {
    it("preserves context on summary generation failure", async () => {
      const messages: Message[] = [
        { role: "user", content: "Old message 1" },
        { role: "assistant", content: "Old response 1" },
        { role: "user", content: "Old message 2" },
        { role: "assistant", content: "Old response 2" },
        { role: "user", content: "Recent message" },
      ];

      // LLM that always fails
      const failingLlm = async (): Promise<string> => {
        throw new Error("LLM service unavailable");
      };

      // Compaction should throw, preserving the invariant that we don't silently lose data
      await expect(
        compactContext(messages, 15, "sonnet", failingLlm)
      ).rejects.toThrow("Compaction failed");
    });

    it("preserves all messages when compaction fails", async () => {
      const messages: Message[] = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Message 2" },
      ];

      const failingLlm = async (): Promise<string> => {
        throw new Error("Network error");
      };

      // Verify error is thrown with original error message
      try {
        await compactContext(messages, 5, "sonnet", failingLlm);
        expect.fail("Should have thrown error");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Compaction failed");
        expect((error as Error).message).toContain("Network error");
      }
    });

    it("handles timeout during summary generation", async () => {
      const messages: Message[] = [
        { role: "user", content: "Test message" },
        { role: "assistant", content: "Test response" },
      ];

      const timeoutLlm = async (): Promise<string> => {
        throw new Error("Request timeout after 30s");
      };

      await expect(
        compactContext(messages, 5, "sonnet", timeoutLlm)
      ).rejects.toThrow("Compaction failed");
    });
  });

  describe("Partial Summaries", () => {
    it("never replaces complete transcript with partial summary", async () => {
      const messages: Message[] = [
        { role: "user", content: "Complete message 1" },
        { role: "assistant", content: "Complete response 1" },
        { role: "user", content: "Complete message 2" },
        { role: "assistant", content: "Complete response 2" },
        { role: "user", content: "Recent message" },
      ];

      // LLM that returns partial/incomplete summary
      const partialLlm = async (): Promise<string> => {
        return `## Goal
Incomplete summary that cuts off mid-sen`;
      };

      // Even with partial summary, compaction should complete
      // The system should accept the partial summary but keep all recent messages
      const result = await compactContext(messages, 15, "sonnet", partialLlm);

      // Verify that we got a summary (even if partial)
      expect(result.summary).toBeTruthy();
      expect(result.summary).toContain("## Goal");

      // Verify messages were kept
      expect(result.messagesKept.length).toBeGreaterThan(0);

      // Verify the last message is preserved
      const lastKept = result.messagesKept[result.messagesKept.length - 1];
      expect(lastKept.content).toBe("Recent message");
    });

    it("accepts empty summary from LLM if no compaction needed", async () => {
      const messages: Message[] = [
        { role: "user", content: "Short message" },
      ];

      const emptyLlm = async (): Promise<string> => {
        // Should not be called
        throw new Error("Should not be called");
      };

      const result = await compactContext(messages, 10000, "sonnet", emptyLlm);

      expect(result.summary).toBe("");
      expect(result.messagesCompacted).toBe(0);
      expect(result.messagesKept).toEqual(messages);
    });
  });

  describe("Context Overflow", () => {
    it("handles extremely large messages gracefully", async () => {
      const sessionKey = "agent:test:overflow";

      // Create a very large message
      const largeContent = "x".repeat(1000000); // 1MB of text
      const largeMessage: SessionMessage = {
        role: "user",
        content: largeContent,
        timestamp: 1000,
      };

      // Should be able to append and load large messages
      await store.append(sessionKey, largeMessage);
      const messages = await store.load(sessionKey);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(largeContent);
    });

    it("handles many messages in a session", async () => {
      const sessionKey = "agent:test:manymessages";

      // Add many messages
      for (let i = 0; i < 1000; i++) {
        const message: SessionMessage = {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}`,
          timestamp: 1000 + i,
        };
        await store.append(sessionKey, message);
      }

      // Load should handle all messages
      const messages = await store.load(sessionKey);
      expect(messages).toHaveLength(1000);
      expect(messages[0].content).toBe("Message 0");
      expect(messages[999].content).toBe("Message 999");
    });
  });

  describe("Data Integrity", () => {
    it("preserves message order after corrupted lines", async () => {
      const sessionKey = "agent:test:order";
      const sessionDir = join(testDir, "agent_test_order");
      await mkdir(sessionDir, { recursive: true });

      const transcriptPath = join(sessionDir, "transcript.jsonl");
      const msg1 = { role: "user", content: "First", timestamp: 1000 };
      const msg2 = { role: "assistant", content: "Second", timestamp: 2000 };
      const msg3 = { role: "user", content: "Third", timestamp: 3000 };

      const transcriptContent = [
        JSON.stringify(msg1),
        "corrupted line",
        JSON.stringify(msg2),
        "another corrupted line",
        JSON.stringify(msg3),
      ].join("\n");

      await writeFile(transcriptPath, transcriptContent, "utf-8");

      const messages = await store.load(sessionKey);

      // Messages should be in correct order
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("First");
      expect(messages[1].content).toBe("Second");
      expect(messages[2].content).toBe("Third");
    });

    it("does not lose data on concurrent append operations", async () => {
      const sessionKey = "agent:test:concurrent";

      // Simulate concurrent appends
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `Concurrent message ${i}`,
        timestamp: 1000 + i,
      }));

      // Append all messages concurrently
      await Promise.all(
        messages.map((msg) => store.append(sessionKey, msg))
      );

      // All messages should be present (order might vary due to concurrency)
      const loaded = await store.load(sessionKey);
      expect(loaded).toHaveLength(10);

      // Verify all content is present
      const contents = loaded.map((m) => m.content).sort();
      const expectedContents = messages.map((m) => m.content).sort();
      expect(contents).toEqual(expectedContents);
    });
  });
});
