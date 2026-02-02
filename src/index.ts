/**
 * index.ts — Public API exports for daemon-engine.
 *
 * Re-exports all public types and functions for library use.
 */

// Config
export { loadConfig } from "./config.js";
export type { Config, AgentConfig, HeartbeatConfig } from "./config.js";

// Workspace
export { buildSystemPrompt, WORKSPACE_FILES } from "./workspace.js";

// Gateway
export { createServer } from "./gateway.js";
export type { Provider, ToolRegistry, ServerDependencies } from "./gateway.js";

// Heartbeat
export { startHeartbeat, stopHeartbeat } from "./heartbeat.js";
export type { HeartbeatHandle } from "./heartbeat.js";

// Provider
export { createAnthropicProvider } from "./provider.js";
export type { AnthropicProvider } from "./provider.js";
