/**
 * registry.ts — Central registry for tools.
 *
 * Provides a registry to store and retrieve tools by name.
 * Ensures type safety by validating that all registered tools match ToolDefinition.
 */

import type { ToolDefinition } from "../agent.js";

/**
 * A registry for looking up tools by name.
 *
 * Tools must be registered before they can be retrieved.
 * All registered tools must conform to the ToolDefinition interface.
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tools: Map<string, ToolDefinition<any>> = new Map();

  /**
   * Register a tool in the registry.
   *
   * @param name - The unique name for the tool
   * @param tool - The tool definition to register
   * @throws {Error} If a tool with the same name is already registered
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(name: string, tool: ToolDefinition<any>): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
  }

  /**
   * Retrieve a tool by name.
   *
   * @param name - The name of the tool to retrieve
   * @returns The tool definition, or undefined if not found
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): ToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered.
   *
   * @param name - The name of the tool to check
   * @returns True if the tool is registered, false otherwise
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tool names.
   *
   * @returns An array of all registered tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

/**
 * Create and populate a registry with built-in tools.
 *
 * Registers the built-in tools: read, write, and exec.
 */
export async function createBuiltInRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  
  // Import and register built-in tools
  const { read } = await import("./read.js");
  const { write } = await import("./write.js");
  const { exec } = await import("./exec.js");
  
  registry.register("read", read);
  registry.register("write", write);
  registry.register("exec", exec);
  
  return registry;
}
