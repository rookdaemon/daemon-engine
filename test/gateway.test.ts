import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Gateway, GatewayConfig, GatewayContext } from "../src/gateway.js";
import { FileSessionStore } from "../src/session.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeResponse } from "../src/providers/claude-cli.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import { SystemPromptOptions } from "../src/workspace.js";

// Mock the claude-cli module
vi.mock("../src/providers/claude-cli.js", () => ({
  callClaude: vi.fn(),
  callClaudeStream: vi.fn(),
}));

import { callClaude, callClaudeStream } from "../src/providers/claude-cli.js";

describe("Gateway", () => {
  let testDir: string;
  let sessionStore: FileSessionStore;
  let gateway: Gateway;
  let mockCallClaude: ReturnType<typeof vi.fn>;
  let mockCallClaudeStream: ReturnType<typeof vi.fn>;

  // Default prompt options for testing
  const defaultPromptOptions: SystemPromptOptions = {
    maxFileChars: 20000,
    timezone: "UTC",
  };

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

    // Setup mock for callClaudeStream
    mockCallClaudeStream = vi.mocked(callClaudeStream);
    mockCallClaudeStream.mockImplementation(async (request, config, onEvent) => {
      // Simulate streaming events
      await onEvent({ type: "token", text: "Hello" });
      await onEvent({ type: "token", text: " from" });
      await onEvent({ type: "token", text: " Claude!" });
      await onEvent({ 
        type: "done", 
        sessionId: "test-session-id",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          costUsd: 0.001,
        },
        durationMs: 1000,
      });

      return {
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
      } as ClaudeResponse;
    });
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
        promptOptions: defaultPromptOptions,
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
      
      // First call should have no continueSession and should have system prompt
      const firstCall = mockCallClaude.mock.calls[0][0];
      expect(firstCall.prompt).toBe("What's your name?");
      expect(firstCall.continueSession).toBeUndefined();
      // Verify prompt was built dynamically and contains workspace-specific content
      expect(firstCall.systemPrompt).toBeTruthy();
      expect(firstCall.systemPrompt).toContain("daemon-engine"); // Should contain runtime info
      
      // Second call should use continueSession with session-1
      // When continuing a session, systemPrompt should be empty string (not sent to Claude)
      const secondCall = mockCallClaude.mock.calls[1][0];
      expect(secondCall.prompt).toBe("Can you help me?");
      expect(secondCall.continueSession).toBe("session-1");
      expect(secondCall.systemPrompt).toBe(""); // Empty when continuing session
      
      // Verify session metadata stores Claude session ID
      const metadata = await sessionStore.getMetadata("test:continuity");
      expect(metadata?.claudeSessionId).toBe("session-2"); // Last session ID
    });

    it("builds system prompt dynamically from workspace files", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:custom-prompt",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
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

      // Verify the system prompt was built dynamically from workspace
      expect(mockCallClaude).toHaveBeenCalled();
      const callArgs = mockCallClaude.mock.calls[mockCallClaude.mock.calls.length - 1][0];
      // The system prompt should be built from workspace and contain workspace-specific content
      expect(callArgs.systemPrompt).toBeTruthy();
      expect(typeof callArgs.systemPrompt).toBe("string");
      expect(callArgs.systemPrompt).toContain("daemon-engine"); // Should contain runtime info
      expect(callArgs.systemPrompt).toContain("Current Date"); // Should contain date/time section
    });

    it("rebuilds system prompt for new sessions after workspace changes", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:workspace-change",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // First message - creates new session
      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "First message" },
        }),
      });

      // Get the system prompt from the first call
      const firstCallArgs = mockCallClaude.mock.calls[0][0];
      const firstSystemPrompt = firstCallArgs.systemPrompt;
      expect(firstSystemPrompt).toBeTruthy();

      // Second message - continues session (no new system prompt)
      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "Second message" },
        }),
      });

      // Second call should have empty system prompt (continuing session)
      const secondCallArgs = mockCallClaude.mock.calls[1][0];
      expect(secondCallArgs.systemPrompt).toBe("");
      expect(secondCallArgs.continueSession).toBeTruthy();

      // Reset the session to force a new session on next message
      await fetch(`http://localhost:${port}/session/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "test:workspace-change",
        }),
      });

      // Now simulate a workspace change by creating a SOUL.md file
      await writeFile(join(testDir, "SOUL.md"), "I am a test agent with a new personality.");

      // Third message - should create new session with fresh system prompt
      await fetch(`http://localhost:${port}/hooks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          type: "test",
          payload: { message: "Third message after workspace change" },
        }),
      });

      // Third call should have a new system prompt (new session after reset)
      const thirdCallArgs = mockCallClaude.mock.calls[2][0];
      expect(thirdCallArgs.systemPrompt).toBeTruthy();
      expect(thirdCallArgs.continueSession).toBeUndefined();
      
      // The new system prompt should include the SOUL.md content
      expect(thirdCallArgs.systemPrompt).toContain("test agent with a new personality");
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
        promptOptions: defaultPromptOptions,
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

      // First call: simulate session expiry error (realistic Claude CLI error format)
      mockCallClaude.mockResolvedValueOnce({
        type: "error",
        result: "Claude CLI exited with code 1\nStderr: Error: Session 'expired-session-id' not found or expired\nStdout: ",
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

  describe("token tracking and context window management", () => {
    it("tracks token usage in session metadata", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:tokens",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // Send first message
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "Response 1",
        sessionId: "session-1",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, costUsd: 0.001 },
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
          payload: { message: "Message 1" },
        }),
      });

      // Check metadata after first message
      let metadata = await sessionStore.getMetadata("test:tokens");
      expect(metadata?.totalInputTokens).toBe(100);
      expect(metadata?.totalOutputTokens).toBe(50);
      expect(metadata?.totalCacheReadTokens).toBe(20);
      expect(metadata?.messageCount).toBe(1);

      // Send second message
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "Response 2",
        sessionId: "session-2",
        usage: { inputTokens: 150, outputTokens: 75, cacheReadTokens: 30, costUsd: 0.002 },
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
          payload: { message: "Message 2" },
        }),
      });

      // Check cumulative token usage
      metadata = await sessionStore.getMetadata("test:tokens");
      expect(metadata?.totalInputTokens).toBe(250);
      expect(metadata?.totalOutputTokens).toBe(125);
      expect(metadata?.totalCacheReadTokens).toBe(50);
      expect(metadata?.messageCount).toBe(2);
    });

    it("resets session when token threshold is reached", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:threshold",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
        maxContextTokens: 200, // Low threshold for testing
      };

      // Create initial session with high token usage (near threshold)
      await sessionStore.setMetadata("test:threshold", {
        sessionKey: "test:threshold",
        model: "claude",
        created: Date.now(),
        lastActive: Date.now(),
        compactionCount: 0,
        claudeSessionId: "old-session-id",
        totalInputTokens: 150,
        totalOutputTokens: 50,
        totalCacheReadTokens: 5,
        messageCount: 3,
      });

      // Add some existing messages to the transcript for carryover
      await sessionStore.append("test:threshold", {
        role: "user",
        content: "Previous message 1",
        timestamp: Date.now() - 3000,
      });
      await sessionStore.append("test:threshold", {
        role: "assistant",
        content: "Previous response 1",
        timestamp: Date.now() - 2000,
      });

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // Mock response for new session after reset
      mockCallClaude.mockResolvedValueOnce({
        type: "success",
        result: "New session response",
        sessionId: "new-session-id",
        usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, costUsd: 0.001 },
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
          payload: { message: "Trigger reset message" },
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.response).toBe("New session response");

      // Verify that Claude was called without session continuation (reset happened)
      expect(mockCallClaude).toHaveBeenCalledTimes(1);
      const callArgs = mockCallClaude.mock.calls[0][0];
      expect(callArgs.continueSession).toBeUndefined(); // No session continuation

      // Verify that the prompt included carryover preamble
      expect(callArgs.prompt).toContain("[Session context carryover");
      expect(callArgs.prompt).toContain("Previous message 1");
      expect(callArgs.prompt).toContain("Previous response 1");
      expect(callArgs.prompt).toContain("Trigger reset message");

      // Verify token counters were reset
      const metadata = await sessionStore.getMetadata("test:threshold");
      expect(metadata?.totalInputTokens).toBe(50); // Reset to new session tokens
      expect(metadata?.totalOutputTokens).toBe(25);
      expect(metadata?.totalCacheReadTokens).toBe(0);
      expect(metadata?.messageCount).toBe(1); // Reset to 1
      expect(metadata?.claudeSessionId).toBe("new-session-id");
    });

    it("handles POST /session/reset endpoint", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:manual-reset",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      // Create a session with some data
      await sessionStore.setMetadata("test:manual-reset", {
        sessionKey: "test:manual-reset",
        model: "claude",
        created: Date.now(),
        lastActive: Date.now(),
        compactionCount: 0,
        claudeSessionId: "existing-session",
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 100,
        messageCount: 5,
      });

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // Call the reset endpoint
      const response = await fetch(`http://localhost:${port}/session/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "test:manual-reset",
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("ok");
      expect(data.message).toBe("Session reset successfully");
      expect(data.sessionKey).toBe("test:manual-reset");

      // Verify session was reset
      const metadata = await sessionStore.getMetadata("test:manual-reset");
      expect(metadata?.claudeSessionId).toBeUndefined();
      expect(metadata?.totalInputTokens).toBe(0);
      expect(metadata?.totalOutputTokens).toBe(0);
      expect(metadata?.totalCacheReadTokens).toBe(0);
    });

    it("requires authentication for POST /session/reset", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:reset-auth",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      // Try without authentication
      const response1 = await fetch(`http://localhost:${port}/session/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "test:reset-auth",
        }),
      });

      expect(response1.status).toBe(401);

      // Try with wrong token
      const response2 = await fetch(`http://localhost:${port}/session/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-token",
        },
        body: JSON.stringify({
          sessionKey: "test:reset-auth",
        }),
      });

      expect(response2.status).toBe(401);
    });

    it("returns 404 for unconfigured session in reset endpoint", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          test: {
            token: "test-token",
            sessionKey: "test:configured",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();

      const response = await fetch(`http://localhost:${port}/session/reset`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "unknown:session",
        }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("No hook configured for session");
    });
  });

  describe("POST /stream", () => {
    it("returns 401 for missing authentication", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          testHook: {
            token: "test-token",
            sessionKey: "test:session",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();
      const response = await fetch(`http://localhost:${port}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: "test:session",
          message: "Hello",
        }),
      });

      expect(response.status).toBe(401);
    });

    it("processes streaming message successfully", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          testHook: {
            token: "test-token",
            sessionKey: "test:session",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();
      const response = await fetch(`http://localhost:${port}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "test:session",
          message: "Hello streaming!",
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      // Read the stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let receivedEvents: Array<{ event: string; data: unknown }> = [];
      
      if (reader) {
        let done = false;
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          
          if (value) {
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            
            let currentEvent = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.substring(7);
              } else if (line.startsWith("data: ")) {
                const data = JSON.parse(line.substring(6));
                receivedEvents.push({ event: currentEvent, data });
              }
            }
          }
        }
      }

      // Verify we received events
      expect(receivedEvents.length).toBeGreaterThan(0);
      
      // Should have token events from the mock
      const tokenEvents = receivedEvents.filter(e => e.event === "token");
      expect(tokenEvents.length).toBeGreaterThan(0);
      
      // Should have at least a done event
      const doneEvent = receivedEvents.find(e => e.event === "done");
      expect(doneEvent).toBeDefined();
      
      // Verify session metadata was updated
      const metadata = await sessionStore.getMetadata("test:session");
      expect(metadata?.claudeSessionId).toBeDefined();
      expect(metadata?.messageCount).toBe(1);
    });

    it("emits token events during streaming", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          testHook: {
            token: "test-token",
            sessionKey: "test:stream",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();
      const response = await fetch(`http://localhost:${port}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "test:stream",
          message: "Test message",
        }),
      });

      expect(response.status).toBe(200);
      
      // Read the stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let receivedEvents: Array<{ event: string; data: unknown }> = [];
      
      if (reader) {
        let done = false;
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          
          if (value) {
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            
            let currentEvent = "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.substring(7);
              } else if (line.startsWith("data: ")) {
                const data = JSON.parse(line.substring(6));
                receivedEvents.push({ event: currentEvent, data });
              }
            }
          }
        }
      }

      // Verify token events are emitted by the mock (3 tokens: "Hello", " from", " Claude!")
      const tokenEvents = receivedEvents.filter(e => e.event === "token");
      expect(tokenEvents.length).toBe(3);
      expect(tokenEvents[0].data).toEqual({ text: "Hello" });
      expect(tokenEvents[1].data).toEqual({ text: " from" });
      expect(tokenEvents[2].data).toEqual({ text: " Claude!" });
      
      // Verify done event is emitted
      const doneEvent = receivedEvents.find(e => e.event === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent) {
        expect(doneEvent.data).toHaveProperty("sessionId");
        expect(doneEvent.data).toHaveProperty("usage");
        expect(doneEvent.data).toHaveProperty("durationMs");
      }
    });

    it("returns 404 for unconfigured session", async () => {
      const config: GatewayConfig = {
        port: 0,
        hooks: {
          testHook: {
            token: "test-token",
            sessionKey: "test:session",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();
      const response = await fetch(`http://localhost:${port}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "unknown:session",
          message: "Hello",
        }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toContain("No hook configured for session");
    });

    it("allows configurable CORS origins", async () => {
      const config: GatewayConfig = {
        port: 0,
        corsOrigins: "https://example.com",
        hooks: {
          testHook: {
            token: "test-token",
            sessionKey: "test:cors",
          },
        },
      };

      const context: GatewayContext = {
        workspaceDir: testDir,
        claudeConfig: {},
        sessionStore,
        promptOptions: defaultPromptOptions,
      };

      gateway = new Gateway(config, context, createNodeEnvironment());
      await gateway.start();

      const port = gateway.getPort();
      const response = await fetch(`http://localhost:${port}/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          sessionKey: "test:cors",
          message: "Test CORS",
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
    });
  });
});
