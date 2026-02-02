import { describe, it, expect, beforeEach } from "vitest";
import {
  runAgent,
  type LLMProvider,
  type Session,
  type Message,
  type ToolRegistry,
} from "../src/agent.js";

describe("runAgent", () => {
  let session: Session;
  let mockLLM: LLMProvider;
  let tools: ToolRegistry;

  beforeEach(() => {
    // Create a fresh session for each test
    session = {
      sessionKey: "test-session",
      model: "test-model",
      messages: [],
    };

    // Mock LLM provider
    mockLLM = {
      chat: async () => ({
        content: "",
        stopReason: "end" as const,
      }),
    };

    // Empty tool registry
    tools = new Map();
  });

  it("returns final text response when LLM responds with no tools", async () => {
    // LLM returns a simple text response
    mockLLM.chat = async () => ({
      content: "Hello! I'm here to help.",
      stopReason: "end" as const,
    });

    const response = await runAgent(session, "You are a helpful assistant.", tools, mockLLM);

    expect(response).toBe("Hello! I'm here to help.");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].content).toBe("Hello! I'm here to help.");
  });

  it("executes single tool call and returns final response", async () => {
    // Register a test tool
    tools.set("get_weather", {
      definition: {
        name: "get_weather",
        description: "Get the weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
      execute: async (args) => {
        return `The weather in ${args.city} is sunny.`;
      },
    });

    let callCount = 0;
    mockLLM.chat = async () => {
      callCount++;
      if (callCount === 1) {
        // First call: LLM requests tool
        return {
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "get_weather",
              arguments: { city: "London" },
            },
          ],
          stopReason: "tool_use" as const,
        };
      } else {
        // Second call: LLM responds with final answer
        return {
          content: "The weather in London is sunny today!",
          stopReason: "end" as const,
        };
      }
    };

    const response = await runAgent(session, "You are a helpful assistant.", tools, mockLLM);

    expect(response).toBe("The weather in London is sunny today!");
    expect(callCount).toBe(2);
    
    // Verify messages were added to session
    expect(session.messages).toHaveLength(3);
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].toolCalls).toBeDefined();
    expect(session.messages[1].role).toBe("tool_result");
    expect(session.messages[1].content).toContain("sunny");
    expect(session.messages[2].role).toBe("assistant");
    expect(session.messages[2].content).toBe("The weather in London is sunny today!");
  });

  it("handles multi-step tool chain", async () => {
    tools.set("calculate", {
      definition: {
        name: "calculate",
        description: "Perform a calculation",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
      execute: async (args) => {
        if (args.expr === "2+2") return "4";
        if (args.expr === "4*10") return "40";
        return "0";
      },
    });

    let callCount = 0;
    mockLLM.chat = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "calculate", arguments: { expr: "2+2" } }],
          stopReason: "tool_use" as const,
        };
      } else if (callCount === 2) {
        return {
          content: "",
          toolCalls: [{ id: "call-2", name: "calculate", arguments: { expr: "4*10" } }],
          stopReason: "tool_use" as const,
        };
      } else {
        return {
          content: "The result is 40.",
          stopReason: "end" as const,
        };
      }
    };

    const response = await runAgent(session, "You are a calculator.", tools, mockLLM);

    expect(response).toBe("The result is 40.");
    expect(callCount).toBe(3);
    expect(session.messages).toHaveLength(5); // assistant, tool_result, assistant, tool_result, assistant
  });

  it("handles tool execution errors gracefully", async () => {
    tools.set("failing_tool", {
      definition: {
        name: "failing_tool",
        description: "A tool that fails",
        parameters: { type: "object" },
      },
      execute: async () => {
        throw new Error("Tool execution failed");
      },
    });

    let callCount = 0;
    mockLLM.chat = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "failing_tool", arguments: {} }],
          stopReason: "tool_use" as const,
        };
      } else {
        return {
          content: "I encountered an error with the tool.",
          stopReason: "end" as const,
        };
      }
    };

    const response = await runAgent(session, "You are a helper.", tools, mockLLM);

    expect(response).toBe("I encountered an error with the tool.");
    expect(session.messages).toHaveLength(3);
    expect(session.messages[1].role).toBe("tool_result");
    expect(session.messages[1].content).toContain("Error");
  });

  it("handles unknown tool gracefully", async () => {
    let callCount = 0;
    mockLLM.chat = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "nonexistent_tool", arguments: {} }],
          stopReason: "tool_use" as const,
        };
      } else {
        return {
          content: "I tried to use a tool that doesn't exist.",
          stopReason: "end" as const,
        };
      }
    };

    const response = await runAgent(session, "You are a helper.", tools, mockLLM);

    expect(response).toBe("I tried to use a tool that doesn't exist.");
    expect(session.messages[1].content).toContain("Unknown tool");
  });

  it("enforces max iterations to prevent infinite loops", async () => {
    // Tool that does nothing but exists
    tools.set("noop", {
      definition: {
        name: "noop",
        description: "Does nothing",
        parameters: { type: "object" },
      },
      execute: async () => "ok",
    });

    // LLM always returns tool calls, never ends
    mockLLM.chat = async () => ({
      content: "",
      toolCalls: [{ id: "call-x", name: "noop", arguments: {} }],
      stopReason: "tool_use" as const,
    });

    // Should throw or return after max iterations
    await expect(async () => {
      await runAgent(session, "You are stuck.", tools, mockLLM);
    }).rejects.toThrow(/max.*iteration/i);
  });

  it("passes system prompt and messages to LLM correctly", async () => {
    type CapturedParams = {
      model: string;
      system: string;
      messages: Message[];
      tools?: unknown;
    };
    
    let receivedParams: CapturedParams | null = null;

    mockLLM.chat = async (params: {
      model: string;
      system: string;
      messages: Message[];
      tools?: unknown;
    }) => {
      // Capture a snapshot of the messages at call time
      receivedParams = {
        model: params.model,
        system: params.system,
        messages: [...params.messages],
        tools: params.tools,
      };
      return {
        content: "Response",
        stopReason: "end" as const,
      };
    };

    session.messages.push({
      role: "user",
      content: "Hello!",
    });

    await runAgent(session, "You are a test bot.", tools, mockLLM);

    // TypeScript type assertion - we know mockLLM.chat was called
    const params = receivedParams as unknown as CapturedParams;
    expect(params).not.toBeNull();
    expect(params.model).toBe("test-model");
    expect(params.system).toBe("You are a test bot.");
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].content).toBe("Hello!");
  });

  it("includes tool definitions when tools are provided", async () => {
    tools.set("test_tool", {
      definition: {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object" },
      },
      execute: async () => "ok",
    });

    let receivedTools: unknown = null;
    mockLLM.chat = async (params) => {
      receivedTools = params.tools;
      return {
        content: "Done",
        stopReason: "end" as const,
      };
    };

    await runAgent(session, "System", tools, mockLLM);

    expect(Array.isArray(receivedTools)).toBe(true);
    expect((receivedTools as unknown[]).length).toBe(1);
  });

  it("appends messages in correct order", async () => {
    tools.set("echo", {
      definition: {
        name: "echo",
        description: "Echo input",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
      execute: async (args) => `Echoed: ${args.text}`,
    });

    let callCount = 0;
    mockLLM.chat = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hello" } }],
          stopReason: "tool_use" as const,
        };
      } else {
        return {
          content: "I echoed your message.",
          stopReason: "end" as const,
        };
      }
    };

    await runAgent(session, "System", tools, mockLLM);

    // Check message order
    expect(session.messages[0].role).toBe("assistant");
    expect(session.messages[0].toolCalls).toBeDefined();
    expect(session.messages[1].role).toBe("tool_result");
    expect(session.messages[1].toolCallId).toBe("call-1");
    expect(session.messages[2].role).toBe("assistant");
    expect(session.messages[2].content).toBe("I echoed your message.");
  });
});
