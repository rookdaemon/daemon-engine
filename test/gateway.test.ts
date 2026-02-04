import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Gateway, GatewayConfig, GatewayContext } from "../src/gateway.js";
import { FileSessionStore } from "../src/session.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeResponse } from "../src/providers/claude-cli.js";
import { createNodeEnvironment } from "../src/env/environment.js";

// Mock the claude-cli module
vi.mock("../src/providers/claude-cli.js", () => ({
  callClaude: vi.fn(),
}));

import { callClaude } from "../src/providers/claude-cli.js";

describe("Gateway", () => {
  let testDir: string;
  let sessionStore: FileSessionStore;
  let gateway: Gateway;
  let mockCallClaude: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-engine-gateway-test-"));
    sessionStore = new FileSessionStore(testDir, createNodeEnvironment());
    
    // Setup mock for callClaude
    mockCallClaude = vi.mocked(callClaude);
    mockCallClaude.mockResolvedValue({
      type: "success",
      result: "Hello from Claude!",
      sessionId: "test-session-id",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        costUsd: 0.001,
      },
      durationMs: 1000,
    } as ClaudeResponse);
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.stop();
    }
    await rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("start and stop", () => {
    it("starts the server on the specified port", async () => {
      const config: GatewayConfig = {
        port: 0, // Use 0 to get a random available port
        hooks: {},
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      // When port is 0, OS assigns a port, so getPort() should return the actual port
      const actualPort = gateway.getPort();
      expect(actualPort).toBeGreaterThan(0);
    });

    it("stops the server cleanly", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {},
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();
      await gateway.stop();
      
      // Should be able to start again after stopping
      await gateway.start();
      await gateway.stop();
    });

    it("throws error when starting an already running server", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {},
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();
      
      await expect(gateway.start()).rejects.toThrow("Gateway server is already running");
    });
  });

  describe("GET /health", () => {
    it("returns health status without authentication", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {},
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("healthy");
      expect(data.version).toBe("0.1.0");
      expect(typeof data.uptime).toBe("number");
      expect(data.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("POST /hooks", () => {
    it("returns 401 for missing authentication", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          agora: {
            token: "secret-token",
            sessionKey: "agora:default",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "agora",
          payload: { message: "Hello" },
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("returns 401 for invalid token", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          agora: {
            token: "secret-token",
            sessionKey: "agora:default",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-token",
        },
        body: JSON.stringify({
          type: "agora",
          payload: { message: "Hello" },
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("returns 404 for unknown hook type", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          agora: {
            token: "secret-token",
            sessionKey: "agora:default",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token",
        },
        body: JSON.stringify({
          type: "unknown",
          payload: { message: "Hello" },
        }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("Unknown hook type");
    });

    it("processes valid webhook and returns response", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          agora: {
            token: "secret-token",
            sessionKey: "agora:default",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token",
        },
        body: JSON.stringify({
          type: "agora",
          payload: {
            from: "user123",
            message: "Hello, bot!",
          },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.response).toBe("Hello from Claude!");
      expect(data.sessionKey).toBe("agora:default");

      // Verify session was updated
      const messages = await sessionStore.load("agora:default");
      expect(messages).toHaveLength(2); // user message + assistant response
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello, bot!");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hello from Claude!");
    });

    it("calls onResponse callback when provided", async () => {
      const onResponseMock = vi.fn().mockResolvedValue(undefined);

      const config: GatewayConfig = {
        port: 0,
        hooks: {
          agora: {
            token: "secret-token",
            sessionKey: "agora:default",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        onResponse: onResponseMock,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token",
        },
        body: JSON.stringify({
          type: "agora",
          payload: { message: "Test" },
        }),
      });

      expect(onResponseMock).toHaveBeenCalledWith("agora:default", "Hello from Claude!");
    });

    it("extracts message from different payload formats", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "secret-token",
            sessionKey: "test:session",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // Test with "text" field
      const response1 = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { text: "Message via text field" },
        }),
      });

      expect(response1.status).toBe(200);
      const messages1 = await sessionStore.load("test:session");
      expect(messages1[0].content).toBe("Message via text field");

      // Clear session
      await sessionStore.clear("test:session");

      // Test with "content" field
      const response2 = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer secret-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { content: "Message via content field" },
        }),
      });

      expect(response2.status).toBe(200);
      const messages2 = await sessionStore.load("test:session");
      expect(messages2[0].content).toBe("Message via content field");
    });
  });

  describe("POST /message", () => {
    it("returns 401 for missing authentication", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          webchat: {
            token: "webchat-token",
            sessionKey: "webchat:main",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "webchat:main",
          message: "Hello",
        }),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("processes direct message successfully", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          webchat: {
            token: "webchat-token",
            sessionKey: "webchat:main",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer webchat-token",
        },
        body: JSON.stringify({
          sessionKey: "webchat:main",
          message: "Direct message test",
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.response).toBe("Hello from Claude!");
      expect(data.sessionKey).toBe("webchat:main");

      // Verify session was updated
      const messages = await sessionStore.load("webchat:main");
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Direct message test");
    });

    it("returns 404 for unconfigured session", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          webchat: {
            token: "webchat-token",
            sessionKey: "webchat:main",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer webchat-token",
        },
        body: JSON.stringify({
          sessionKey: "unknown:session",
          message: "Test",
        }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("No hook configured for session");
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {},
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/unknown`, {
        method: "GET",
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Not found");
    });
  });

  describe("session continuity", () => {
    it("maintains conversation history across multiple messages", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:continuity",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // First message
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "I'm Claude, nice to meet you!",
        sessionId: "session-1",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, costUsd: 0 },
        durationMs: 100,
      } as ClaudeResponse);

      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "What's your name?" },
        }),
      });

      // Second message
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "I can help you with that!",
        sessionId: "session-2",
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, costUsd: 0 },
        durationMs: 100,
      } as ClaudeResponse);

      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "Can you help me?" },
        }),
      });

      // Verify session has both exchanges
      const messages = await sessionStore.load("test:continuity");
      expect(messages).toHaveLength(4); // 2 user messages + 2 assistant responses
      
      // Check the order and content
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("What's your name?");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("I'm Claude, nice to meet you!");
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toBe("Can you help me?");
      expect(messages[3].role).toBe("assistant");
      expect(messages[3].content).toBe("I can help you with that!");

      // Verify that the second call used session continuation
      expect(mockCallClaude).toHaveBeenCalledTimes(2);
      
      // First call should have no continueSession
      const firstCall = mockCallClaude.mock.calls[0][0];
      expect(firstCall.prompt).toBe("What's your name?");
      expect(firstCall.continueSession).toBeUndefined();
      expect(firstCall.systemPrompt).toBe("You are a helpful AI assistant.");
      
      // Second call should use continueSession with session-1
      const secondCall = mockCallClaude.mock.calls[1][0];
      expect(secondCall.prompt).toBe("Can you help me?");
      expect(secondCall.continueSession).toBe("session-1");
      expect(secondCall.systemPrompt).toBe("You are a helpful AI assistant.");
      
      // Verify session metadata stores Claude session ID
      const metadata = await sessionStore.getMetadata("test:continuity");
      expect(metadata?.claudeSessionId).toBe("session-2"); // Last session ID
    });

    it("uses custom system prompt when provided", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:custom-prompt",
          },
        },
        systemPrompt: "You are a pirate assistant. Always respond like a pirate.",
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "Hello" },
        }),
      });

      // Verify the custom system prompt was used
      expect(mockCallClaude).toHaveBeenCalled();
      const callArgs = mockCallClaude.mock.calls[mockCallClaude.mock.calls.length - 1][0];
      expect(callArgs.systemPrompt).toBe("You are a pirate assistant. Always respond like a pirate.");
    });

    it("handles expired Claude session gracefully", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:expiry",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
      };

      // Set up an existing session with Claude session ID
      await sessionStore.setMetadata("test:expiry", {
        claudeSessionId: "expired-session-id",
        sessionKey: "test:expiry",
        model: "claude",
        created: Date.now(),
        lastActive: Date.now(),
        compactionCount: 0,
      });

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // First call: simulate session expiry error
      mockCallClaude.mockResolvedValueOnce({
        type: "error",
        result: "Claude CLI error: session expired-session-id not found",
        sessionId: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
        durationMs: 100,
      } as ClaudeResponse);

      // Second call (retry): successful new session
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "New session started",
        sessionId: "new-session-id",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, costUsd: 0 },
        durationMs: 100,
      } as ClaudeResponse);

      const response = await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "Test message" },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response).toBe("New session started");

      // Verify that Claude was called twice (once with expired session, once without)
      expect(mockCallClaude).toHaveBeenCalledTimes(2);
      
      // First call should have tried to continue with expired session
      const firstCall = mockCallClaude.mock.calls[0][0];
      expect(firstCall.continueSession).toBe("expired-session-id");
      
      // Second call should start a new session (no continueSession)
      const secondCall = mockCallClaude.mock.calls[1][0];
      expect(secondCall.continueSession).toBeUndefined();
      
      // Verify new session ID was saved
      const metadata = await sessionStore.getMetadata("test:expiry");
      expect(metadata?.claudeSessionId).toBe("new-session-id");
    });
  });
});
