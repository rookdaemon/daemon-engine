import { describe, it, expect } from "vitest";
import { ToolRegistry, createBuiltInRegistry } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/agent.js";

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const registry = new ToolRegistry();
    const mockTool: ToolDefinition<{ value: string }> = {
      description: "A mock tool for testing",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
      execute: async (params) => `Executed with: ${params.value}`,
    };

    registry.register("mock", mockTool);

    const retrieved = registry.get("mock");
    expect(retrieved).toBe(mockTool);
    expect(retrieved?.description).toBe("A mock tool for testing");
  });

  it("returns undefined for non-existent tool", () => {
    const registry = new ToolRegistry();

    const result = registry.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("checks if tool exists with has()", () => {
    const registry = new ToolRegistry();
    const mockTool: ToolDefinition<unknown> = {
      description: "Test tool",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async () => "result",
    };

    expect(registry.has("test")).toBe(false);

    registry.register("test", mockTool);

    expect(registry.has("test")).toBe(true);
  });

  it("gets all registered tool names", () => {
    const registry = new ToolRegistry();
    const tool1: ToolDefinition<unknown> = {
      description: "Tool 1",
      parameters: { type: "object", properties: {} },
      execute: async () => "1",
    };
    const tool2: ToolDefinition<unknown> = {
      description: "Tool 2",
      parameters: { type: "object", properties: {} },
      execute: async () => "2",
    };

    registry.register("tool1", tool1);
    registry.register("tool2", tool2);

    const names = registry.getToolNames();
    expect(names).toContain("tool1");
    expect(names).toContain("tool2");
    expect(names).toHaveLength(2);
  });

  it("gets all registered tools as a map", () => {
    const registry = new ToolRegistry();
    const mockTool: ToolDefinition<unknown> = {
      description: "Test",
      parameters: { type: "object", properties: {} },
      execute: async () => "result",
    };

    registry.register("test", mockTool);

    const allTools = registry.getAll();
    expect(allTools.size).toBe(1);
    expect(allTools.get("test")).toBe(mockTool);

    // Verify it's a copy (mutation shouldn't affect original)
    allTools.delete("test");
    expect(registry.has("test")).toBe(true);
  });

  it("allows overwriting existing tool", () => {
    const registry = new ToolRegistry();
    const tool1: ToolDefinition<unknown> = {
      description: "First version",
      parameters: { type: "object", properties: {} },
      execute: async () => "v1",
    };
    const tool2: ToolDefinition<unknown> = {
      description: "Second version",
      parameters: { type: "object", properties: {} },
      execute: async () => "v2",
    };

    registry.register("tool", tool1);
    expect(registry.get("tool")?.description).toBe("First version");

    registry.register("tool", tool2);
    expect(registry.get("tool")?.description).toBe("Second version");
  });
});

describe("createBuiltInRegistry", () => {
  it("creates a registry with built-in tools", async () => {
    const registry = await createBuiltInRegistry();

    expect(registry.has("read")).toBe(true);
    expect(registry.has("write")).toBe(true);
    expect(registry.has("exec")).toBe(true);
  });

  it("registered read tool has correct structure", async () => {
    const registry = await createBuiltInRegistry();
    const readTool = registry.get("read");

    expect(readTool).toBeDefined();
    expect(readTool?.description).toBeTruthy();
    expect(readTool?.parameters).toBeDefined();
    expect(readTool?.parameters.type).toBe("object");
    expect(readTool?.parameters.properties.path).toBeDefined();
    expect(readTool?.execute).toBeTypeOf("function");
  });

  it("registered write tool has correct structure", async () => {
    const registry = await createBuiltInRegistry();
    const writeTool = registry.get("write");

    expect(writeTool).toBeDefined();
    expect(writeTool?.description).toBeTruthy();
    expect(writeTool?.parameters).toBeDefined();
    expect(writeTool?.parameters.type).toBe("object");
    expect(writeTool?.parameters.properties.path).toBeDefined();
    expect(writeTool?.parameters.properties.content).toBeDefined();
    expect(writeTool?.execute).toBeTypeOf("function");
  });

  it("registered exec tool has correct structure", async () => {
    const registry = await createBuiltInRegistry();
    const execTool = registry.get("exec");

    expect(execTool).toBeDefined();
    expect(execTool?.description).toBeTruthy();
    expect(execTool?.parameters).toBeDefined();
    expect(execTool?.parameters.type).toBe("object");
    expect(execTool?.parameters.properties.command).toBeDefined();
    expect(execTool?.execute).toBeTypeOf("function");
  });

  it("returns exactly 4 built-in tools", async () => {
    const registry = await createBuiltInRegistry();
    const toolNames = registry.getToolNames();

    expect(toolNames).toHaveLength(4);
    expect(toolNames.sort()).toEqual(["exec", "read", "web_search", "write"]);
  });
});
