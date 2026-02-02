/**
 * config.ts — Configuration types and loader.
 *
 * Defines the Config type that describes agents, channels, and runtime settings.
 * (Full implementation will be in a separate task)
 */

/**
 * Agent configuration.
 */
export interface AgentConfig {
  /** Agent identifier (unique key in agents map) */
  id: string;
  /** LLM model name */
  model: string;
  /** Path to workspace directory */
  workspace: string;
  /** Available tool names */
  tools: string[];
}

/**
 * Main configuration object.
 */
export interface Config {
  /** Map of agent ID to agent config */
  agents: Map<string, AgentConfig>;
}
