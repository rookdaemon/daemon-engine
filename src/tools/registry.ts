/**
 * registry.ts — Central registry for tools.
 *
 * Provides a type-safe registry for looking up tools by name during execution.
 * Includes automatic registration of built-in tools (read, write, exec).
 */

import type { ToolDefinition } from "../agent.js";

/**
 * Central registry for tools.
 *
 * Allows registration and lookup of tools by name.
 * Tools are stored with their ToolDefinition.
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools: Map<string, ToolDefinition<any>> = new Map();

  /**
   * Register a tool with the given name.
   *
   * @param name - Unique identifier for the tool
   * @param tool - Tool definition matching ToolDefinition interface
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(name: string, tool: ToolDefinition<any>): void {
    this.tools.set(name, tool);
  }

  /**
   * Retrieve a tool by name.
   *
   * @param name - Name of the tool to retrieve
   * @returns The tool definition, or undefined if not found
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered.
   *
   * @param name - Name of the tool to check
   * @returns True if the tool is registered, false otherwise
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tool names.
   *
   * @returns Array of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all registered tools as a map.
   *
   * @returns Map of tool names to tool definitions
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAll(): Map<string, ToolDefinition<any>> {
    return new Map(this.tools);
  }
}

/**
 * Create and populate a registry with built-in tools.
 *
 * Registers the standard tools: read, write, and exec.
 *
 * @returns A ToolRegistry populated with built-in tools
 */
export async function createBuiltInRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  // Dynamically import built-in tools
  const { read } = await import("./read.js");
  const { write } = await import("./write.js");
  const { exec } = await import("./exec.js");

  // Register built-in tools
  registry.register("read", read);
  registry.register("write", write);
  registry.register("exec", exec);

  return registry;
}
