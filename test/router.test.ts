import { describe, it, expect, beforeEach } from "vitest";
import { routeMessage } from "../src/router.js";
import type { Config } from "../src/config.js";
import type { AgentConfig } from "../src/config.js";
import { clearSessions } from "../src/session.js";

describe("routeMessage", () => {
  let config: Config;

  beforeEach(() => {
    // Clear session state before each test
    clearSessions();

    // Setup test config with agents
    const agent1: AgentConfig = {
      id: "agent1",
      model: "claude-3-opus",
      workspace: "/tmp/workspace1",
      tools: ["read", "write"],
    };

    const agent2: AgentConfig = {
      id: "agent2",
      model: "gpt-4",
      workspace: "/tmp/workspace2",
      tools: ["exec"],
    };

    config = {
      agents: new Map([
        ["agent1", agent1],
        ["agent2", agent2],
      ]),
    };
  });

  describe("session key construction", () => {
    it("constructs session key as agent:agentId:channel:channelId", () => {
      const msg = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      const session = routeMessage(msg, config);

      expect(session.key).toBe("agent:agent1:webchat:user123");
    });

    it("uses different session keys for different channels", () => {
      const msg1 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello from web",
      };

      const msg2 = {
        agentId: "agent1",
        channel: "discord",
        channelId: "user123",
        content: "Hello from discord",
      };

      const session1 = routeMessage(msg1, config);
      const session2 = routeMessage(msg2, config);

      expect(session1.key).not.toBe(session2.key);
      expect(session1.key).toBe("agent:agent1:webchat:user123");
      expect(session2.key).toBe("agent:agent1:discord:user123");
    });

    it("uses different session keys for different channel IDs", () => {
      const msg1 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      const msg2 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user456",
        content: "Hi",
      };

      const session1 = routeMessage(msg1, config);
      const session2 = routeMessage(msg2, config);

      expect(session1.key).not.toBe(session2.key);
    });
  });

  describe("session creation and retrieval", () => {
    it("creates a new session on first message from a source", () => {
      const msg = {
        agentId: "agent1",
        channel: "telegram",
        channelId: "chat789",
        content: "First message",
      };

      const session = routeMessage(msg, config);

      expect(session.key).toBe("agent:agent1:telegram:chat789");
      expect(session.agentId).toBe("agent1");
      expect(session.channel).toBe("telegram");
      expect(session.channelId).toBe("chat789");
    });

    it("retrieves existing session for returning source", () => {
      const msg1 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "First message",
      };

      const msg2 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Second message",
      };

      const session1 = routeMessage(msg1, config);
      const session2 = routeMessage(msg2, config);

      // Should be the same session object
      expect(session1).toBe(session2);
      expect(session1.key).toBe(session2.key);
    });

    it("creates separate sessions for different agents", () => {
      const msg1 = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello agent1",
      };

      const msg2 = {
        agentId: "agent2",
        channel: "webchat",
        channelId: "user123",
        content: "Hello agent2",
      };

      const session1 = routeMessage(msg1, config);
      const session2 = routeMessage(msg2, config);

      expect(session1.key).not.toBe(session2.key);
      expect(session1.agentId).toBe("agent1");
      expect(session2.agentId).toBe("agent2");
    });
  });

  describe("default agent resolution", () => {
    it("uses default agent when agentId is omitted and only one agent exists", () => {
      const singleAgentConfig: Config = {
        agents: new Map([
          [
            "onlyagent",
            {
              id: "onlyagent",
              model: "claude-3-sonnet",
              workspace: "/tmp/workspace",
              tools: [],
            },
          ],
        ]),
      };

      const msg = {
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      const session = routeMessage(msg, singleAgentConfig);

      expect(session.agentId).toBe("onlyagent");
      expect(session.key).toBe("agent:onlyagent:webchat:user123");
    });

    it("throws error when agentId is omitted and multiple agents exist", () => {
      const msg = {
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      expect(() => routeMessage(msg, config)).toThrow(
        /agentId is required/i,
      );
    });

    it("throws error when agentId is omitted and no agents exist", () => {
      const emptyConfig: Config = {
        agents: new Map(),
      };

      const msg = {
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      expect(() => routeMessage(msg, emptyConfig)).toThrow(
        /no agents configured/i,
      );
    });
  });

  describe("model override", () => {
    it("passes model override to session when specified", () => {
      const msg = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
        model: "gpt-4-turbo",
      };

      const session = routeMessage(msg, config);

      expect(session.model).toBe("gpt-4-turbo");
    });

    it("does not set model when not specified", () => {
      const msg = {
        agentId: "agent1",
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      const session = routeMessage(msg, config);

      expect(session.model).toBeUndefined();
    });
  });

  describe("invalid input", () => {
    it("throws error when specified agentId does not exist in config", () => {
      const msg = {
        agentId: "nonexistent",
        channel: "webchat",
        channelId: "user123",
        content: "Hello",
      };

      expect(() => routeMessage(msg, config)).toThrow(
        /agent.*not found/i,
      );
    });

    it("validates required fields are present", () => {
      const invalidMsg = {
        agentId: "agent1",
        // missing channel
        channelId: "user123",
        content: "Hello",
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => routeMessage(invalidMsg as any, config)).toThrow();
    });
  });
});
