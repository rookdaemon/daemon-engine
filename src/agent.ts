/**
 * agent.ts — LLM call loop (message → tools → response).
 *
 * This module defines the core agent interface and tool execution model.
 * Tools are async functions with typed parameters that the agent can call.
 */

/**
 * A tool that the agent can execute.
 *
 * Each tool has a name, description, parameter schema, and an execute function.
 * The execute function receives validated parameters and returns a result string.
 */
export interface ToolDefinition<T = unknown> {
  /** Human-readable description of what the tool does. */
  description: string;

  /** JSON Schema describing the tool's parameters. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };

  /** Execute the tool with the given parameters. Returns a result string. */
  execute: (params: T) => Promise<string>;
}
