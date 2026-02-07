/**
 * agent.test.ts — Tests for the agent execution loop (ReAct pattern).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgent, ToolContext } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { LlmProvider, ProviderRequest, ProviderResponse, Message } from "../src/providers/types.js";
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
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
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
      async generate(request: ProviderRequest): Promise<ProviderResponse> {
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
    expect(capturedRequest!.toolDefinitions).toHaveLength(1);
    expect(capturedRequest!.toolDefinitions![0].name).toBe("test_tool");
    expect(capturedRequest!.toolDefinitions![0].description).toBe("A test tool for conversion");
    expect(capturedRequest!.toolDefinitions![0].parameters).toEqual({
      type: "object",
      properties: {
        param1: { type: "string", description: "First parameter" },
        param2: { type: "number", description: "Second parameter" },
      },
      required: ["param1"],
    });
  });
});
