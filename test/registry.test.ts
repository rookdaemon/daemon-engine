import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry, createBuiltInRegistry } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/agent.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    it("registers a tool successfully", () => {
      const mockTool: ToolDefinition = {
        description: "A mock tool",
        parameters: {
          type: "object",
          properties: {},
        },
        execute: async () => "result",
      };

      registry.register("mock", mockTool);

      expect(registry.has("mock")).toBe(true);
    });

    it("throws when registering duplicate tool name", () => {
      const mockTool: ToolDefinition = {
        description: "A mock tool",
        parameters: {
          type: "object",
          properties: {},
        },
        execute: async () => "result",
      };

      registry.register("mock", mockTool);

      expect(() => registry.register("mock", mockTool)).toThrow(
        'Tool "mock" is already registered'
      );
    });

    it("allows different tools with different names", () => {
      const tool1: ToolDefinition = {
        description: "Tool 1",
        parameters: { type: "object", properties: {} },
        execute: async () => "result1",
      };

      const tool2: ToolDefinition = {
        description: "Tool 2",
        parameters: { type: "object", properties: {} },
        execute: async () => "result2",
      };

      registry.register("tool1", tool1);
      registry.register("tool2", tool2);

      expect(registry.has("tool1")).toBe(true);
      expect(registry.has("tool2")).toBe(true);
    });
  });

  describe("get", () => {
    it("retrieves a registered tool", () => {
      const mockTool: ToolDefinition = {
        description: "A mock tool",
        parameters: {
          type: "object",
          properties: {},
        },
        execute: async () => "result",
      };

      registry.register("mock", mockTool);

      const retrieved = registry.get("mock");
      expect(retrieved).toBe(mockTool);
    });

    it("returns undefined for unregistered tool", () => {
      const retrieved = registry.get("nonexistent");
      expect(retrieved).toBeUndefined();
    });

    it("retrieves the correct tool when multiple are registered", () => {
      const tool1: ToolDefinition = {
        description: "Tool 1",
        parameters: { type: "object", properties: {} },
        execute: async () => "result1",
      };

      const tool2: ToolDefinition = {
        description: "Tool 2",
        parameters: { type: "object", properties: {} },
        execute: async () => "result2",
      };

      registry.register("tool1", tool1);
      registry.register("tool2", tool2);

      expect(registry.get("tool1")).toBe(tool1);
      expect(registry.get("tool2")).toBe(tool2);
    });
  });

  describe("has", () => {
    it("returns true for registered tools", () => {
      const mockTool: ToolDefinition = {
        description: "A mock tool",
        parameters: { type: "object", properties: {} },
        execute: async () => "result",
      };

      registry.register("mock", mockTool);

      expect(registry.has("mock")).toBe(true);
    });

    it("returns false for unregistered tools", () => {
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  describe("getNames", () => {
    it("returns empty array for new registry", () => {
      expect(registry.getNames()).toEqual([]);
    });

    it("returns all registered tool names", () => {
      const tool1: ToolDefinition = {
        description: "Tool 1",
        parameters: { type: "object", properties: {} },
        execute: async () => "result1",
      };

      const tool2: ToolDefinition = {
        description: "Tool 2",
        parameters: { type: "object", properties: {} },
        execute: async () => "result2",
      };

      registry.register("tool1", tool1);
      registry.register("tool2", tool2);

      const names = registry.getNames();
      expect(names).toContain("tool1");
      expect(names).toContain("tool2");
      expect(names).toHaveLength(2);
    });
  });

  describe("type safety", () => {
    it("enforces ToolDefinition interface", () => {
      const validTool: ToolDefinition<{ param1: string }> = {
        description: "Valid tool",
        parameters: {
          type: "object",
          properties: {
            param1: { type: "string" },
          },
          required: ["param1"],
        },
        execute: async (params) => {
          return `Executed with ${params.param1}`;
        },
      };

      registry.register("valid", validTool);

      const retrieved = registry.get("valid");
      expect(retrieved).toBeDefined();
      expect(retrieved?.description).toBe("Valid tool");
      expect(retrieved?.parameters.type).toBe("object");
      expect(retrieved?.parameters.properties.param1).toBeDefined();
    });

    it("can execute registered tools", async () => {
      const executableTool: ToolDefinition<{ input: string }> = {
        description: "Executable tool",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
          required: ["input"],
        },
        execute: async (params) => {
          return `Processed: ${params.input}`;
        },
      };

      registry.register("executable", executableTool);

      const retrieved = registry.get("executable");
      const result = await retrieved?.execute({ input: "test" });

      expect(result).toBe("Processed: test");
    });
  });

  describe("registration of built-in tools", () => {
    it("can register tools with complex parameter schemas", () => {
      const complexTool: ToolDefinition = {
        description: "Complex tool",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            options: {
              type: "object",
              properties: {
                encoding: { type: "string" },
              },
            },
          },
          required: ["path", "content"],
        },
        execute: async () => "result",
      };

      registry.register("complex", complexTool);

      const retrieved = registry.get("complex");
      expect(retrieved).toBeDefined();
      expect(retrieved?.parameters.properties.path).toBeDefined();
      expect(retrieved?.parameters.properties.content).toBeDefined();
      expect(retrieved?.parameters.required).toContain("path");
      expect(retrieved?.parameters.required).toContain("content");
    });
  });

  describe("createBuiltInRegistry", () => {
    it("creates a registry with built-in tools", async () => {
      const builtInRegistry = await createBuiltInRegistry();

      expect(builtInRegistry.has("read")).toBe(true);
      expect(builtInRegistry.has("write")).toBe(true);
      expect(builtInRegistry.has("exec")).toBe(true);
    });

    it("registers all three built-in tools", async () => {
      const builtInRegistry = await createBuiltInRegistry();
      const names = builtInRegistry.getNames();

      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("exec");
      expect(names).toHaveLength(3);
    });

    it("registered tools are callable", async () => {
      const builtInRegistry = await createBuiltInRegistry();
      
      const readTool = builtInRegistry.get("read");
      const writeTool = builtInRegistry.get("write");
      const execTool = builtInRegistry.get("exec");

      expect(readTool).toBeDefined();
      expect(writeTool).toBeDefined();
      expect(execTool).toBeDefined();

      expect(typeof readTool?.execute).toBe("function");
      expect(typeof writeTool?.execute).toBe("function");
      expect(typeof execTool?.execute).toBe("function");
    });
  });
});
