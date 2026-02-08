import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderRequest } from "../src/providers/types.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";

// Mock credential resolution to return a fixed token
vi.mock("../src/providers/anthropic-oauth-credentials.js", () => ({
  resolveSessionToken: vi.fn().mockResolvedValue("sk-ant-oat01-test-token"),
  isOAuthToken: (t: string) => t.includes("sk-ant-oat"),
}));

// Mock Anthropic SDK to capture constructor args and provide mock create
let capturedAnthropicConfig: { apiKey: unknown; authToken?: string; defaultHeaders?: Record<string, string> } | null = null;
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor(config: unknown) {
      capturedAnthropicConfig = config as typeof capturedAnthropicConfig;
    }
    messages = {
      create: mockCreate,
    };
  },
}));

describe("ClaudeOAuthProvider", () => {
  let mockEnv: Environment;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedAnthropicConfig = null;

    const baseEnv = createNodeEnvironment();
    mockEnv = {
      ...baseEnv,
      clock: { now: () => Date.now() },
    };

    await import("../src/providers/claude-oauth.js");
    // Clear module cache to get fresh provider with mocked deps
  });

  it("uses authToken not apiKey when creating client", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      {
        sessionToken: "sk-ant-oat01-manual",
        model: "claude-3-5-sonnet-20241022",
      },
      mockEnv
    );

    mockCreate.mockResolvedValueOnce({
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await provider.generate(
      {
        messages: [{ role: "user", content: "Hi" }],
        systemPrompt: "Assistant",
      },
      mockEnv
    );

    expect(capturedAnthropicConfig).not.toBeNull();
    expect(capturedAnthropicConfig?.authToken).toBe("sk-ant-oat01-test-token");
    expect(capturedAnthropicConfig?.apiKey).toBeNull();
  });

  it("includes Claude Code headers", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      { sessionToken: "sk-ant-oat01-x", credentialStorePath: undefined },
      mockEnv
    );

    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await provider.generate(
      { messages: [{ role: "user", content: "Test" }], systemPrompt: "" },
      mockEnv
    );

    const headers = capturedAnthropicConfig?.defaultHeaders;
    expect(headers).toBeDefined();
    expect(headers?.["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers?.["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers?.["user-agent"]).toContain("claude-cli/");
    expect(headers?.["x-app"]).toBe("cli");
  });

  it("prepends Claude Code identity to system prompt", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      { sessionToken: "sk-ant-oat01-x" },
      mockEnv
    );

    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await provider.generate(
      {
        messages: [{ role: "user", content: "Test" }],
        systemPrompt: "You help with coding.",
      },
      mockEnv
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(callArgs.system).toContain("You help with coding.");
  });

  it("converts tool names to Claude Code canonical casing", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      { sessionToken: "sk-ant-oat01-x" },
      mockEnv
    );

    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Use read and exec" }],
      systemPrompt: "Help",
      toolDefinitions: [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {}, required: [] },
        },
        {
          name: "exec",
          description: "Execute command",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
    };

    await provider.generate(request, mockEnv);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Bash");
  });

  it("maps response tool names back to registry names", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      { sessionToken: "sk-ant-oat01-x" },
      mockEnv
    );

    mockCreate.mockResolvedValueOnce({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
      model: "claude-3-5-sonnet-20241022",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "List files" }],
      systemPrompt: "Help",
      toolDefinitions: [
        {
          name: "exec",
          description: "Execute",
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.type).toBe("success");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.name).toBe("exec");
    expect(response.toolCalls?.[0]?.input).toEqual({ command: "ls" });
  });

  it("handles errors gracefully", async () => {
    const { ClaudeOAuthProvider } = await import("../src/providers/claude-oauth.js");
    const provider = new ClaudeOAuthProvider(
      { sessionToken: "sk-ant-oat01-x" },
      mockEnv
    );

    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const response = await provider.generate(
      {
        messages: [{ role: "user", content: "Test" }],
        systemPrompt: "",
      },
      mockEnv
    );

    expect(response.type).toBe("error");
    expect(response.result).toContain("API error");
  });
});
