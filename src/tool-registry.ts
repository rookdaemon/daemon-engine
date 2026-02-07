/**
 * tool-registry.ts — Registry for managing available tools.
 *
 * This module provides a registry that stores tool definitions and executes
 * them when requested by the LLM.
 */

import type { ToolDefinition } from "./agent.js";
import type { ToolCall } from "./session.js";
import { log } from "./logger.js";

/**
 * Context passed to tool execution.
 * 
 * Provides access to environment information that tools might need.
 */
export interface ToolContext {
  /** Working directory for file operations. */
  workspaceDir: string;
}

/**
 * Registry for managing and executing tools.
 * 
 * Stores tool definitions and provides methods to execute them based on
 * tool calls from the LLM.
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition<unknown>> = new Map();

  /**
   * Register a tool in the registry.
   * 
   * @param name - Name of the tool
   * @param definition - Tool definition with execute function
   */
  register<T = unknown>(name: string, definition: ToolDefinition<T>): void {
    this.tools.set(name, definition as ToolDefinition<unknown>);
    log.info("[tool-registry]", `Registered tool: ${name}`);
  }

  /**
   * Get all registered tool names.
   * 
   * @returns Array of tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool definitions in a format suitable for the provider.
   * 
   * @returns Array of tool names (for Claude CLI --tools parameter)
   */
  getToolDefinitions(): string[] {
    return this.getToolNames();
  }

  /**
   * Execute a tool call.
   * 
   * @param toolCall - Tool call from the LLM
   * @param _context - Execution context (reserved for future use)
   * @returns Result string from tool execution
   */
  async execute(toolCall: ToolCall, _context: ToolContext): Promise<string> {
    const tool = this.tools.get(toolCall.name);
    
    if (!tool) {
      const error = `Tool not found: ${toolCall.name}`;
      log.error("[tool-registry]", error);
      return error;
    }

    try {
      log.info("[tool-registry]", `Executing tool: ${toolCall.name}`);
      const result = await tool.execute(toolCall.input);
      log.info("[tool-registry]", `Tool ${toolCall.name} completed successfully`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error("[tool-registry]", `Tool ${toolCall.name} failed: ${errorMsg}`);
      return `Error executing ${toolCall.name}: ${errorMsg}`;
    }
  }
}
