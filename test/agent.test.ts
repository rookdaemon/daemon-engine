/**
 * agent.test.ts — Tests for the agent execution loop (ReAct pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgent, ToolContext } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "../src/providers/types.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("runAgent", () => {
  let env: Environment;
  let toolContext: ToolContext;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    env = createNodeEnvironment();
    toolContext = {
      workspace: "/test/workspace",
      env,
      sessionKey: "test-session",
    };
    toolRegistry = new ToolRegistry();
  });

  it("should return final response when LLM completes without tools", async () => {
    // Mock provider that returns a simple response
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        return {
          type: "success",
          result: "Hello, this is my response!",
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
          durationMs: 100,
          stopReason: "end_turn",
        };
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Hello!" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(result.result).toBe("Hello, this is my response!");
    expect(result.turns).toBe(1);
    expect(result.totalUsage.inputTokens).toBe(10);
    expect(result.totalUsage.outputTokens).toBe(20);
    expect(result.messages).toHaveLength(2); // Original user message + assistant response
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("Hello, this is my response!");
  });

  it("should execute tools when LLM requests them", async () => {
    // Register a test tool
    const mockToolExecute = vi.fn(async (params: { value: number }) => {
      return `Tool result: ${params.value * 2}`;
    });

    toolRegistry.register("multiply", {
      description: "Multiply a value by 2",
      parameters: {
        type: "object",
        properties: {
          value: { type: "number", description: "Value to multiply" },
        },
        required: ["value"],
      },
      execute: mockToolExecute,
    });

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          // First call: request tool use
          return {
            type: "success",
            result: "I'll use the multiply tool",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "call_1",
                name: "multiply",
                input: { value: 5 },
              },
            ],
          };
        } else {
          // Second call: final response after tool execution
          return {
            type: "success",
            result: "The result is 10",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "What is 5 times 2?" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(callCount).toBe(2);
    expect(mockToolExecute).toHaveBeenCalledWith({ value: 5 }, toolContext);
    expect(result.turns).toBe(2);
    expect(result.result).toBe("The result is 10");
    expect(result.totalUsage.inputTokens).toBe(25); // 10 + 15
    expect(result.totalUsage.outputTokens).toBe(30); // 20 + 10
  });

  it("should handle multiple tool calls in sequence", async () => {
    // Register two tools
    toolRegistry.register("add", {
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
      execute: async (params: { a: number; b: number }) => {
        return `${params.a + params.b}`;
      },
    });

    toolRegistry.register("multiply", {
      description: "Multiply two numbers",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
      execute: async (params: { a: number; b: number }) => {
        return `${params.a * params.b}`;
      },
    });

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          return {
            type: "success",
            result: "",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              { id: "call_1", name: "add", input: { a: 3, b: 4 } },
              { id: "call_2", name: "multiply", input: { a: 5, b: 6 } },
            ],
          };
        } else {
          return {
            type: "success",
            result: "First sum is 7, second product is 30",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Calculate some numbers" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    // Check that tool results were added to messages
    expect(result.messages.some(m => m.content.includes("Tool result for add") && m.content.includes("7"))).toBe(true);
    expect(result.messages.some(m => m.content.includes("Tool result for multiply") && m.content.includes("30"))).toBe(true);
  });

  it("should handle tool execution errors gracefully", async () => {
    // Register a tool that throws an error
    toolRegistry.register("failing_tool", {
      description: "A tool that always fails",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => {
        throw new Error("Tool execution failed!");
      },
    });

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          return {
            type: "success",
            result: "",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              { id: "call_1", name: "failing_tool", input: {} },
            ],
          };
        } else {
          return {
            type: "success",
            result: "I encountered an error",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Use the failing tool" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    // Should have error message in the tool result
    expect(result.messages.some(m => m.content.includes("Error executing tool"))).toBe(true);
  });

  it("should handle unknown tool requests", async () => {
    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          return {
            type: "success",
            result: "",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              { id: "call_1", name: "nonexistent_tool", input: {} },
            ],
          };
        } else {
          return {
            type: "success",
            result: "Tool not found",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Use a tool" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    // Should have error message about tool not found
    expect(result.messages.some(m => m.content.includes("Tool not found in registry"))).toBe(true);
  });

  it("should enforce max turns limit", async () => {
    // Mock provider that always requests tools
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        return {
          type: "success",
          result: "",
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
          durationMs: 100,
          stopReason: "tool_use",
          toolCalls: [
            { id: "call_1", name: "test_tool", input: {} },
          ],
        };
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    toolRegistry.register("test_tool", {
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => "result",
    });

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Keep using tools" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
      maxTurns: 3,
    });

    expect(result.turns).toBe(3);
    expect(result.result).toContain("exceeded maximum turns");
  });

  it("should accumulate token usage across multiple turns", async () => {
    toolRegistry.register("test_tool", {
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => "result",
    });

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount <= 2) {
          return {
            type: "success",
            result: "",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              { id: `call_${callCount}`, name: "test_tool", input: {} },
            ],
          };
        } else {
          return {
            type: "success",
            result: "Done",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 3, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(result.turns).toBe(3);
    expect(result.totalUsage.inputTokens).toBe(35); // 10 + 10 + 15
    expect(result.totalUsage.outputTokens).toBe(50); // 20 + 20 + 10
    expect(result.totalUsage.cacheReadTokens).toBe(13); // 5 + 5 + 3
    expect(result.totalUsage.costUsd).toBe(0.0025); // 0.001 + 0.001 + 0.0005
    expect(result.totalDurationMs).toBe(280); // 100 + 100 + 80
  });

  it("should convert tool definitions to provider format", async () => {
    toolRegistry.register("test_tool", {
      description: "A test tool for conversion",
      parameters: {
        type: "object",
        properties: {
          param1: { type: "string", description: "First parameter" },
          param2: { type: "number", description: "Second parameter" },
        },
        required: ["param1"],
      },
      execute: async () => "result",
    });

    let capturedRequest: ProviderRequest | null = null;
    const mockProvider: LlmProvider = {
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
        capturedRequest = request;
        return {
          type: "success",
          result: "Done",
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
          durationMs: 100,
          stopReason: "end_turn",
        };
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Test" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    expect(capturedRequest).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const request = capturedRequest!;
    expect(request.toolDefinitions).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const toolDef = request.toolDefinitions![0];
    expect(toolDef.name).toBe("test_tool");
    expect(toolDef.description).toBe("A test tool for conversion");
    expect(toolDef.parameters).toEqual({
      type: "object",
      properties: {
        param1: { type: "string", description: "First parameter" },
        param2: { type: "number", description: "Second parameter" },
      },
      required: ["param1"],
    });
  });

  it("should execute web_search tool when requested by LLM", async () => {
    // Import and register web_search tool
    const { webSearch } = await import("../src/tools/web-search.js");
    toolRegistry.register("web_search", webSearch);

    // Mock the environment with a fake fetch for Brave API
    const mockEnv = {
      ...env,
      process: {
        ...env.process,
        env: (key: string) => {
          if (key === "BRAVE_API_KEY") return "test-api-key";
          return env.process.env(key);
        },
      },
      http: {
        ...env.http,
        fetch: async () => {
          // Mock Brave Search API response
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              web: {
                results: [
                  {
                    title: "Daemon Engine Documentation",
                    url: "https://github.com/rookdaemon/daemon-engine",
                    description: "A self-upgradeable agent runtime.",
                  },
                ],
              },
            }),
          } as Response;
        },
      },
    };

    const mockToolContext = {
      ...toolContext,
      env: mockEnv,
    };

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          // First call: LLM requests web_search tool
          return {
            type: "success",
            result: "I'll search for that information",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "call_1",
                name: "web_search",
                input: { query: "daemon engine", count: 10 },
              },
            ],
          };
        } else {
          // Second call: final response after web_search execution
          return {
            type: "success",
            result: "I found information about Daemon Engine: it's a self-upgradeable agent runtime.",
            usage: { inputTokens: 15, outputTokens: 25, cacheReadTokens: 0, costUsd: 0.0015 },
            durationMs: 120,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Search for daemon engine" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext: mockToolContext,
      env: mockEnv,
    });

    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.result).toContain("self-upgradeable agent runtime");
    
    // Verify tool result message contains search results
    const toolResultMessage = result.messages.find(
      m => m.role === "user" && m.content.includes("Daemon Engine Documentation")
    );
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.content).toContain("github.com/rookdaemon/daemon-engine");
  });

  it("should execute message tool within agent loop", async () => {
    // Import and register the message tool
    const { message } = await import("../src/tools/message.js");
    toolRegistry.register("message", message);

    // Mock fetch for Discord webhook
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
    })) as unknown as (input: string | URL, init?: RequestInit) => Promise<Response>;

    const mockEnv: Environment = {
      ...env,
      http: {
        ...env.http,
        fetch: mockFetch,
      },
    };

    // Create tool context with config including channels
    const toolContextWithConfig: ToolContext = {
      ...toolContext,
      env: mockEnv,
      config: {
        model: {
          provider: "anthropic",
          name: "test-model",
          apiKey: "test-key",
        },
        workspace: "/test/workspace",
        server: { port: 3000 },
        channels: {
          "discord-general": {
            type: "discord-webhook",
            url: "https://discord.com/api/webhooks/123/abc",
          },
        },
      },
    };

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;

        if (callCount === 1) {
          // First call: LLM decides to send a message
          return {
            type: "success",
            result: "I'll send a message to Discord",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "call_1",
                name: "message",
                input: {
                  channel: "discord-general",
                  content: "Hello from the agent!",
                },
              },
            ],
          };
        } else {
          // Second call: Final response after tool execution
          return {
            type: "success",
            result: "Message sent successfully to Discord",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Send a message to discord-general" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext: toolContextWithConfig,
      env: mockEnv,
    });

    // Verify the agent completed the task
    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.result).toBe("Message sent successfully to Discord");

    // Verify the message tool was called correctly
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Hello from the agent!" }),
      }
    );
  });
});

describe("runAgent with edit tool", () => {
  let env: Environment;
  let toolContext: ToolContext;
  let toolRegistry: ToolRegistry;
  let workDir: string;

  beforeEach(async () => {
    // Create a temporary workspace directory
    const { mkdtemp } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    
    workDir = await mkdtemp(join(tmpdir(), "daemon-engine-agent-edit-test-"));
    env = createNodeEnvironment();
    toolContext = {
      workspace: workDir,
      env,
      sessionKey: "test-session",
    };
    toolRegistry = new ToolRegistry();
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(workDir, { recursive: true, force: true });
  });

  it("should successfully execute edit tool in agent loop", async () => {
    // Import and register the actual edit tool
    const { edit } = await import("../src/tools/edit.js");
    toolRegistry.register("edit", edit);

    // Create a test file in the workspace
    const { join } = await import("node:path");
    const testFilePath = join(workDir, "test-file.txt");
    await env.fs.writeFile(testFilePath, "Hello, world!", "utf-8");

    let callCount = 0;
    const mockProvider: LlmProvider = {
      async generate(): Promise<ProviderResponse> {
        callCount++;
        
        if (callCount === 1) {
          // First call: LLM decides to use the edit tool
          return {
            type: "success",
            result: "I'll edit the file for you",
            usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, costUsd: 0.001 },
            durationMs: 100,
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "call_1",
                name: "edit",
                input: {
                  path: testFilePath,
                  old_string: "world",
                  new_string: "universe",
                },
              },
            ],
          };
        } else {
          // Second call: final response after tool execution
          return {
            type: "success",
            result: "I've successfully edited the file",
            usage: { inputTokens: 15, outputTokens: 10, cacheReadTokens: 0, costUsd: 0.0005 },
            durationMs: 80,
            stopReason: "end_turn",
          };
        }
      },
      async generateStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      toolRegistry,
      messages: [{ role: "user", content: "Replace 'world' with 'universe' in the file" }],
      systemPrompt: "You are a helpful assistant.",
      toolContext,
      env,
    });

    // Verify the agent loop completed successfully
    expect(callCount).toBe(2);
    expect(result.turns).toBe(2);
    expect(result.result).toBe("I've successfully edited the file");

    // Verify the file was actually edited
    const editedContent = await env.fs.readFile(testFilePath, "utf-8");
    expect(editedContent).toBe("Hello, universe!");

    // Verify tool result was added to messages
    expect(result.messages.some(m => 
      m.content.includes("test-file.txt") && 
      m.content.includes("replaced 1 occurrence")
    )).toBe(true);
  });
});
