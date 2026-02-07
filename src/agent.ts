/**
 * agent.ts — LLM call loop (message → tools → response).
 *
 * This module defines the core agent interface and tool execution model.
 * Tools are async functions with typed parameters that the agent can call.
 */

import type { Environment } from "./env/environment.js";
import type { Config } from "./config.js";

/**
 * Context provided to tool execution.
 *
 * Contains all the runtime context needed for tools to operate:
 * workspace directory, environment abstraction, session identifier, and config.
 */
export interface ToolContext {
  /** Absolute path to the workspace directory. */
  workspace: string;
  /** Environment abstraction for filesystem, subprocess, etc. */
  env: Environment;
  /** Unique session identifier (e.g., "agent:main:webchat"). */
  sessionKey: string;
  /** Runtime configuration. */
  config: Config;
}

/**
 * A tool that the agent can execute.
 *
 * Each tool has a name, description, parameter schema, and an execute function.
 * The execute function receives validated parameters and a context object.
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

  /** Execute the tool with the given parameters and context. Returns a result string. */
  execute: (params: T, context: ToolContext) => Promise<string>;
}
