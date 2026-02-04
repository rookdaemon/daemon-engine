import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore, SessionMessage, SessionMetadata } from "../src/session.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("FileSessionStore", () => {
  let testDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-engine-session-test-"));
    store = new FileSessionStore(testDir, createNodeEnvironment());
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("load and append", () => {
    it("returns empty array for non-existent session", async () => {
      const messages = await store.load("agent:test:session1");
      expect(messages).toEqual([]);
    });

    it("appends and loads messages in order", async () => {
      const sessionKey = "agent:test:session1";

      const msg1: SessionMessage = {
        role: "user",
        content: "Hello",
        timestamp: 1706954400000,
      };

      const msg2: SessionMessage = {
        role: "assistant",
        content: "Hi there!",
        timestamp: 1706954401000,
      };

      await store.append(sessionKey, msg1);
      await store.append(sessionKey, msg2);

      const messages = await store.load(sessionKey);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(msg1);
      expect(messages[1]).toEqual(msg2);
    });

    it("handles assistant messages with tool calls", async () => {
      const sessionKey = "agent:test:session2";

      const msg: SessionMessage = {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "exec",
            input: { command: "ls" },
          },
        ],
        timestamp: 1706954402000,
      };

      await store.append(sessionKey, msg);

      const messages = await store.load(sessionKey);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
      expect(messages[0].toolCalls).toHaveLength(1);
      expect(messages[0].toolCalls?.[0].name).toBe("exec");
    });

    it("handles tool result messages", async () => {
      const sessionKey = "agent:test:session3";

      const msg: SessionMessage = {
        role: "tool",
        content: "file1.txt\nfile2.txt",
        toolCallId: "call_1",
        timestamp: 1706954403000,
      };

      await store.append(sessionKey, msg);

      const messages = await store.load(sessionKey);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
      expect(messages[0].toolCallId).toBe("call_1");
    });

    it("preserves order across multiple appends", async () => {
      const sessionKey = "agent:test:order";

      // Simulate a conversation with multiple turns
      const messages: SessionMessage[] = [
        { role: "user", content: "First", timestamp: 1000 },
        { role: "assistant", content: "Second", timestamp: 2000 },
        { role: "user", content: "Third", timestamp: 3000 },
        { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read", input: {} }], timestamp: 4000 },
        { role: "tool", content: "Result", toolCallId: "c1", timestamp: 5000 },
        { role: "assistant", content: "Fourth", timestamp: 6000 },
      ];

      for (const msg of messages) {
        await store.append(sessionKey, msg);
      }

      const loaded = await store.load(sessionKey);

      expect(loaded).toHaveLength(6);
      expect(loaded).toEqual(messages);
    });
  });

  describe("metadata", () => {
    it("returns null for non-existent session metadata", async () => {
      const metadata = await store.getMetadata("agent:test:nosession");
      expect(metadata).toBeNull();
    });

    it("sets and retrieves metadata", async () => {
      const sessionKey = "agent:test:meta1";

      const metadata: SessionMetadata = {
        sessionKey,
        model: "anthropic/claude-sonnet-4",
        created: 1706954400000,
        lastActive: 1706954500000,
        compactionCount: 0,
      };

      await store.setMetadata(sessionKey, metadata);

      const retrieved = await store.getMetadata(sessionKey);

      expect(retrieved).toEqual(metadata);
    });

    it("updates existing metadata", async () => {
      const sessionKey = "agent:test:meta2";

      // Set initial metadata
      await store.setMetadata(sessionKey, {
        sessionKey,
        model: "anthropic/claude-sonnet-4",
        created: 1706954400000,
        lastActive: 1706954400000,
        compactionCount: 0,
      });

      // Update lastActive
      await store.setMetadata(sessionKey, {
        lastActive: 1706954600000,
      });

      const retrieved = await store.getMetadata(sessionKey);

      expect(retrieved?.lastActive).toBe(1706954600000);
      expect(retrieved?.created).toBe(1706954400000);
      expect(retrieved?.model).toBe("anthropic/claude-sonnet-4");
    });

    it("increments compaction count", async () => {
      const sessionKey = "agent:test:compact";

      await store.setMetadata(sessionKey, {
        sessionKey,
        model: "anthropic/claude-sonnet-4",
        created: 1706954400000,
        lastActive: 1706954400000,
        compactionCount: 0,
      });

      // Simulate compaction
      const current = await store.getMetadata(sessionKey);
      await store.setMetadata(sessionKey, {
        compactionCount: (current?.compactionCount ?? 0) + 1,
      });

      const updated = await store.getMetadata(sessionKey);

      expect(updated?.compactionCount).toBe(1);
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await store.list();
      expect(sessions).toEqual([]);
    });

    it("lists all session keys", async () => {
      const sessionKeys = [
        "agent:main:webchat",
        "agent:main:discord",
        "agent:test:session1",
      ];

      // Create sessions by appending a message to each
      for (const key of sessionKeys) {
        await store.append(key, {
          role: "user",
          content: "test",
          timestamp: Date.now(),
        });
      }

      const listed = await store.list();

      expect(listed).toHaveLength(3);
      expect(listed).toContain("agent:main:webchat");
      expect(listed).toContain("agent:main:discord");
      expect(listed).toContain("agent:test:session1");
    });

    it("lists sessions created via metadata only", async () => {
      await store.setMetadata("agent:meta:only", {
        sessionKey: "agent:meta:only",
        model: "test",
        created: Date.now(),
        lastActive: Date.now(),
        compactionCount: 0,
      });

      const listed = await store.list();

      expect(listed).toContain("agent:meta:only");
    });
  });

  describe("clear", () => {
    it("removes all session files", async () => {
      const sessionKey = "agent:test:clear1";

      // Create session with messages and metadata
      await store.append(sessionKey, {
        role: "user",
        content: "test",
        timestamp: Date.now(),
      });

      await store.setMetadata(sessionKey, {
        sessionKey,
        model: "test",
        created: Date.now(),
        lastActive: Date.now(),
        compactionCount: 0,
      });

      // Verify session exists
      expect(await store.load(sessionKey)).toHaveLength(1);
      expect(await store.getMetadata(sessionKey)).not.toBeNull();

      // Clear session
      await store.clear(sessionKey);

      // Verify session is gone
      expect(await store.load(sessionKey)).toEqual([]);
      expect(await store.getMetadata(sessionKey)).toBeNull();
    });

    it("handles clearing non-existent session gracefully", async () => {
      await expect(store.clear("agent:test:nonexistent")).resolves.not.toThrow();
    });

    it("removes session from list after clear", async () => {
      const sessionKey = "agent:test:clear2";

      await store.append(sessionKey, {
        role: "user",
        content: "test",
        timestamp: Date.now(),
      });

      // Verify in list
      expect(await store.list()).toContain(sessionKey);

      // Clear and verify removed from list
      await store.clear(sessionKey);
      expect(await store.list()).not.toContain(sessionKey);
    });
  });

  describe("session key sanitization", () => {
    it("handles session keys with special characters", async () => {
      const sessionKey = "agent:main:webchat/user@123";

      await store.append(sessionKey, {
        role: "user",
        content: "test",
        timestamp: Date.now(),
      });

      const messages = await store.load(sessionKey);
      expect(messages).toHaveLength(1);
    });

    it("handles colons in session keys", async () => {
      const sessionKey = "agent:main:discord:channel:123456";

      await store.append(sessionKey, {
        role: "user",
        content: "test",
        timestamp: Date.now(),
      });

      const messages = await store.load(sessionKey);
      expect(messages).toHaveLength(1);
    });
  });

  describe("load/save round-trip", () => {
    it("preserves all message properties through round-trip", async () => {
      const sessionKey = "agent:test:roundtrip";

      const originalMessages: SessionMessage[] = [
        {
          role: "user",
          content: "Hello, world!",
          timestamp: 1706954400000,
        },
        {
          role: "assistant",
          content: "Hi!",
          timestamp: 1706954401000,
        },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "exec",
              input: { command: "ls -la" },
            },
          ],
          timestamp: 1706954402000,
        },
        {
          role: "tool",
          content: "file1.txt\nfile2.txt",
          toolCallId: "call_1",
          timestamp: 1706954403000,
        },
      ];

      // Save all messages
      for (const msg of originalMessages) {
        await store.append(sessionKey, msg);
      }

      // Load and verify
      const loaded = await store.load(sessionKey);

      expect(loaded).toEqual(originalMessages);
    });
  });
});
