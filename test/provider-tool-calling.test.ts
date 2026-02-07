/**
 * provider-tool-calling.test.ts — Tests for tool calling support in providers.
 *
 * Tests verify that providers correctly:
 * 1. Send tool definitions to LLM APIs (where supported)
 * 2. Parse tool call responses
 * 3. Map to standard ProviderResponse format with toolCalls and stopReason
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.js";
import { ClaudeCliProvider } from "../src/providers/claude-adapter.js";
import { callClaudeStream } from "../src/providers/claude-cli.js";
import type { ProviderRequest } from "../src/providers/types.js";
import type { Environment } from "../src/env/environment.js";
import { createNodeEnvironment } from "../src/env/environment.js";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

describe("GeminiProvider tool calling", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockEnv: Environment;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    const baseEnv = createNodeEnvironment();
    mockEnv = {
      ...baseEnv,
      http: {
        ...baseEnv.http,
        fetch: mockFetch as unknown as typeof fetch,
      },
      clock: {
        now: () => Date.now(),
      },
    };
  });

  it("correctly formats tool definitions for Gemini API", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-1.5-flash",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "I'll help you" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Calculate something" }],
      systemPrompt: "You are helpful",
      toolDefinitions: [
        {
          name: "calculate",
          description: "Perform a calculation",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string", description: "Math expression" },
            },
            required: ["expression"],
          },
        },
      ],
    };

    await provider.generate(request, mockEnv);

    // Verify the request body has tools in Gemini format
    const callArgs = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(callArgs[1].body);
    
    expect(requestBody.tools).toBeDefined();
    expect(requestBody.tools[0].functionDeclarations).toBeDefined();
    expect(requestBody.tools[0].functionDeclarations[0]).toEqual({
      name: "calculate",
      description: "Perform a calculation",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression" },
        },
        required: ["expression"],
      },
    });
  });

  it("sets stopReason to tool_use when function calls are present", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "get_weather",
                    args: { location: "San Francisco" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "What's the weather?" }],
      systemPrompt: "You are helpful",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("sets stopReason to end_turn when no function calls", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "Hello!" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      text: async () => "",
    });

    const request: ProviderRequest = {
      messages: [{ role: "user", content: "Say hi" }],
      systemPrompt: "You are helpful",
    };

    const response = await provider.generate(request, mockEnv);

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolCalls).toBeUndefined();
  });
});

describe("ClaudeCliProvider tool calling", () => {
  const mockSpawn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to create a mock child process with streaming events.
   */
  function createMockStreamingChildProcess(events: Array<{
    delay: number;
    data: string;
  }>): Partial<ChildProcess> & EventEmitter {
    const child = new EventEmitter();
    const mockChild = child as Partial<ChildProcess> & EventEmitter;
    mockChild.stdout = new EventEmitter() as ChildProcess["stdout"];
    mockChild.stderr = new EventEmitter() as ChildProcess["stderr"];
    mockChild.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ChildProcess["stdin"];
    mockChild.kill = vi.fn();

    // Emit events over time
    let currentDelay = 10;
    for (const event of events) {
      currentDelay += event.delay;
      setTimeout(() => {
        if (mockChild.stdout) {
          mockChild.stdout.emit("data", Buffer.from(event.data + "\n"));
        }
      }, currentDelay);
    }

    // Exit after all events
    setTimeout(() => {
      mockChild.emit("exit", 0);
    }, currentDelay + 10);

    return mockChild;
  }

  it("captures tool_use events from Claude CLI stream", async () => {
    const mockChild = createMockStreamingChildProcess([
      {
        delay: 5,
        data: JSON.stringify({
          type: "text",
          text: "I'll use the bash tool",
        }),
      },
      {
        delay: 5,
        data: JSON.stringify({
          type: "tool_use",
          id: "tool_123",
          name: "bash",
          input: { command: "ls -la" },
        }),
      },
      {
        delay: 5,
        data: JSON.stringify({
          type: "result",
          session_id: "session_456",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
          },
          total_cost_usd: 0.001,
        }),
      },
    ]);

    const baseEnv = createNodeEnvironment();
    const mockEnv: Environment = {
      ...baseEnv,
      subprocess: {
        spawn: mockSpawn.mockReturnValueOnce(mockChild),
        execFile: vi.fn(),
      },
    };

    const events: Array<{ type: string; name?: string; id?: string }> = [];
    const onEvent = vi.fn(async (event) => {
      events.push(event);
    });

    const response = await callClaudeStream(
      {
        messages: [{ role: "user", content: "List files" }],
        systemPrompt: "You are helpful",
      },
      {},
      onEvent,
      mockEnv
    );

    // Verify we captured the tool call
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    
    // Assert toolCalls is defined before accessing
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].name).toBe("bash");
    expect(response.toolCalls[0].id).toBe("tool_123");
    expect(response.toolCalls[0].input).toEqual({ command: "ls -la" });

    // Verify the event callback was called with tool_call event
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].name).toBe("bash");
  });

  it("sets stopReason to end_turn when no tool calls", async () => {
    const mockChild = createMockStreamingChildProcess([
      {
        delay: 5,
        data: JSON.stringify({
          type: "text",
          text: "Hello!",
        }),
      },
      {
        delay: 5,
        data: JSON.stringify({
          type: "result",
          session_id: "session_789",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
          },
          total_cost_usd: 0.0001,
        }),
      },
    ]);

    const baseEnv = createNodeEnvironment();
    const mockEnv: Environment = {
      ...baseEnv,
      subprocess: {
        spawn: mockSpawn.mockReturnValueOnce(mockChild),
        execFile: vi.fn(),
      },
    };

    const onEvent = vi.fn();

    const response = await callClaudeStream(
      {
        messages: [{ role: "user", content: "Say hi" }],
        systemPrompt: "You are helpful",
      },
      {},
      onEvent,
      mockEnv
    );

    expect(response.stopReason).toBe("end_turn");
    expect(response.toolCalls).toBeUndefined();
  });

  it("propagates tool calls through ClaudeCliProvider adapter", async () => {
    const mockChild = createMockStreamingChildProcess([
      {
        delay: 5,
        data: JSON.stringify({
          type: "tool_use",
          id: "tool_abc",
          name: "read",
          input: { path: "/tmp/test.txt" },
        }),
      },
      {
        delay: 5,
        data: JSON.stringify({
          type: "result",
          session_id: "session_xyz",
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_read_tokens: 0,
          },
          total_cost_usd: 0.0005,
        }),
      },
    ]);

    const baseEnv = createNodeEnvironment();
    const mockEnv: Environment = {
      ...baseEnv,
      subprocess: {
        spawn: mockSpawn.mockReturnValueOnce(mockChild),
        execFile: vi.fn(),
      },
    };

    const provider = new ClaudeCliProvider();
    const onEvent = vi.fn();

    const response = await provider.generateStream(
      {
        messages: [{ role: "user", content: "Read the file" }],
        systemPrompt: "You are helpful",
      },
      onEvent,
      mockEnv
    );

    // Verify the adapter passes through tool calls and stopReason
    expect(response.stopReason).toBe("tool_use");
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);
    
    // Assert toolCalls is defined before accessing
    if (!response.toolCalls) throw new Error("toolCalls should be defined");
    
    expect(response.toolCalls[0].name).toBe("read");
    expect(response.toolCalls[0].id).toBe("tool_abc");
  });
});
