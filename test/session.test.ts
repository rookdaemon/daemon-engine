import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import {
  createSession,
  getSession,
  listSessions,
  addMessage,
  persistSession,
  loadSession,
  validateSessionKey,
  clearRegistry,
} from "../src/session.js";

describe("session module", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daemon-session-test-"));
    clearRegistry();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    clearRegistry();
  });

  describe("validateSessionKey", () => {
    it("validates correct session key format", () => {
      expect(validateSessionKey("agent:test-agent:user-123")).toBe(true);
      expect(validateSessionKey("agent:my-agent:channel-discord")).toBe(true);
      expect(validateSessionKey("agent:a:b")).toBe(true);
    });

    it("rejects invalid session key formats", () => {
      expect(validateSessionKey("invalid-key")).toBe(false);
      expect(validateSessionKey("agent:only-one-part")).toBe(false);
      expect(validateSessionKey("user:test:123")).toBe(false);
      expect(validateSessionKey("")).toBe(false);
      expect(validateSessionKey("agent::missing-agentid")).toBe(false);
    });
  });

  describe("createSession", () => {
    it("creates a session with valid key format", () => {
      const session = createSession("agent:test:user1", {
        model: "claude-3-5-sonnet-20241022",
        channel: "webchat",
      });

      expect(session.sessionKey).toBe("agent:test:user1");
      expect(session.messages).toEqual([]);
      expect(session.metadata.model).toBe("claude-3-5-sonnet-20241022");
      expect(session.metadata.channel).toBe("webchat");
      expect(session.metadata.createdAt).toBeTypeOf("number");
      expect(session.metadata.updatedAt).toBeTypeOf("number");
    });

    it("throws error for invalid session key format", () => {
      expect(() =>
        createSession("invalid-key", {
          model: "test",
          channel: "test",
        })
      ).toThrow("Invalid session key format");
    });

    it("adds session to registry", () => {
      createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });

      const retrieved = getSession("agent:test:session1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.sessionKey).toBe("agent:test:session1");
    });
  });

  describe("getSession", () => {
    it("retrieves existing session from registry", () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });
      const retrieved = getSession("agent:test:session1");

      expect(retrieved).toBe(session);
    });

    it("returns undefined for non-existent session", () => {
      expect(getSession("agent:test:nonexistent")).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("lists all active sessions", () => {
      createSession("agent:test:session1", {
        model: "model1",
        channel: "webchat",
      });
      createSession("agent:test:session2", {
        model: "model2",
        channel: "discord",
      });

      const sessions = listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionKey)).toContain(
        "agent:test:session1"
      );
      expect(sessions.map((s) => s.sessionKey)).toContain(
        "agent:test:session2"
      );
    });

    it("returns empty array when no sessions exist", () => {
      expect(listSessions()).toEqual([]);
    });
  });

  describe("addMessage", () => {
    it("adds message to session", () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });

      addMessage(session, {
        role: "user",
        content: "Hello",
      });

      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe("user");
      expect(session.messages[0].content).toBe("Hello");
      expect(session.messages[0].timestamp).toBeTypeOf("number");
    });

    it("updates session updatedAt timestamp", async () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });
      const initialUpdatedAt = session.metadata.updatedAt;

      // Wait a small amount to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 5));

      addMessage(session, {
        role: "assistant",
        content: "Response",
      });

      expect(session.metadata.updatedAt).toBeGreaterThan(initialUpdatedAt);
    });

    it("adds multiple messages in order", () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });

      addMessage(session, { role: "user", content: "First" });
      addMessage(session, { role: "assistant", content: "Second" });
      addMessage(session, { role: "user", content: "Third" });

      expect(session.messages).toHaveLength(3);
      expect(session.messages[0].content).toBe("First");
      expect(session.messages[1].content).toBe("Second");
      expect(session.messages[2].content).toBe("Third");
    });
  });

  describe("persistSession", () => {
    it("saves session as JSONL file", async () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });
      addMessage(session, { role: "user", content: "Hello" });
      addMessage(session, { role: "assistant", content: "Hi there" });

      await persistSession(session, tempDir);

      const filepath = join(tempDir, "agent:test:session1.jsonl");
      const content = await readFile(filepath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      const msg1 = JSON.parse(lines[0]);
      const msg2 = JSON.parse(lines[1]);

      expect(msg1.role).toBe("user");
      expect(msg1.content).toBe("Hello");
      expect(msg2.role).toBe("assistant");
      expect(msg2.content).toBe("Hi there");
    });

    it("uses default directory if not specified", async () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });
      addMessage(session, { role: "user", content: "Test" });

      const defaultDir = join(homedir(), ".daemon-engine", "sessions");
      await mkdir(defaultDir, { recursive: true });

      try {
        await persistSession(session);
        const filepath = join(defaultDir, "agent:test:session1.jsonl");
        const content = await readFile(filepath, "utf-8");
        expect(content).toContain("Test");
      } finally {
        // Clean up
        await rm(join(defaultDir, "agent:test:session1.jsonl"), {
          force: true,
        });
      }
    });

    it("creates directory if it doesn't exist", async () => {
      const session = createSession("agent:test:session1", {
        model: "test-model",
        channel: "test",
      });
      addMessage(session, { role: "user", content: "Test" });

      const newDir = join(tempDir, "nested", "sessions");
      await persistSession(session, newDir);

      const filepath = join(newDir, "agent:test:session1.jsonl");
      const content = await readFile(filepath, "utf-8");
      expect(content).toContain("Test");
    });
  });

  describe("loadSession", () => {
    it("loads session from JSONL file", async () => {
      const jsonl =
        '{"role":"user","content":"First message","timestamp":1234567890}\n{"role":"assistant","content":"Response","timestamp":1234567891}\n';
      const filepath = join(tempDir, "agent:test:session1.jsonl");
      await writeFile(filepath, jsonl);

      const session = await loadSession("agent:test:session1", tempDir, {
        model: "test-model",
        channel: "test",
      });

      expect(session.sessionKey).toBe("agent:test:session1");
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].content).toBe("First message");
      expect(session.messages[1].content).toBe("Response");
      expect(session.metadata.model).toBe("test-model");
      expect(session.metadata.channel).toBe("test");
    });

    it("returns empty session if file doesn't exist", async () => {
      const session = await loadSession("agent:test:nonexistent", tempDir, {
        model: "test-model",
        channel: "test",
      });

      expect(session.sessionKey).toBe("agent:test:nonexistent");
      expect(session.messages).toEqual([]);
    });

    it("handles empty JSONL file", async () => {
      const filepath = join(tempDir, "agent:test:empty.jsonl");
      await writeFile(filepath, "");

      const session = await loadSession("agent:test:empty", tempDir, {
        model: "test-model",
        channel: "test",
      });

      expect(session.messages).toEqual([]);
    });

    it("adds loaded session to registry", async () => {
      const jsonl =
        '{"role":"user","content":"Test","timestamp":1234567890}\n';
      const filepath = join(tempDir, "agent:test:session1.jsonl");
      await writeFile(filepath, jsonl);

      await loadSession("agent:test:session1", tempDir, {
        model: "test-model",
        channel: "test",
      });

      const retrieved = getSession("agent:test:session1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.messages).toHaveLength(1);
    });
  });

  describe("round-trip persistence", () => {
    it("persists and loads session maintaining data integrity", async () => {
      const session = createSession("agent:test:roundtrip", {
        model: "claude-3-5-sonnet-20241022",
        channel: "discord",
      });

      addMessage(session, { role: "system", content: "System prompt" });
      addMessage(session, { role: "user", content: "User message" });
      addMessage(session, { role: "assistant", content: "Assistant response" });

      await persistSession(session, tempDir);

      // Clear registry and reload
      clearRegistry();

      const loaded = await loadSession("agent:test:roundtrip", tempDir, {
        model: "claude-3-5-sonnet-20241022",
        channel: "discord",
      });

      expect(loaded.messages).toHaveLength(3);
      expect(loaded.messages[0].role).toBe("system");
      expect(loaded.messages[0].content).toBe("System prompt");
      expect(loaded.messages[1].role).toBe("user");
      expect(loaded.messages[2].role).toBe("assistant");
    });

    it("preserves timestamps when loading from JSONL", async () => {
      const session = createSession("agent:test:timestamps", {
        model: "test-model",
        channel: "test",
      });

      // Add messages with different timestamps
      addMessage(session, { role: "user", content: "First" });
      const firstMessageTime = session.messages[0].timestamp;

      await new Promise((resolve) => setTimeout(resolve, 5));

      addMessage(session, { role: "assistant", content: "Second" });
      const secondMessageTime = session.messages[1].timestamp;

      await persistSession(session, tempDir);
      clearRegistry();

      const loaded = await loadSession("agent:test:timestamps", tempDir, {
        model: "test-model",
        channel: "test",
      });

      // Verify message timestamps are preserved
      expect(loaded.messages[0].timestamp).toBe(firstMessageTime);
      expect(loaded.messages[1].timestamp).toBe(secondMessageTime);

      // Verify metadata timestamps are derived from messages
      expect(loaded.metadata.createdAt).toBe(firstMessageTime);
      expect(loaded.metadata.updatedAt).toBe(secondMessageTime);
    });
  });
});
