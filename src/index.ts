/**
 * index.ts — Main entry point for daemon-engine.
 *
 * Exports public API for the daemon engine runtime.
 */

export { Gateway, GatewayConfig, GatewayContext, HookConfig } from "./gateway.js";
export { SessionStore, FileSessionStore, SessionMessage, SessionMetadata, ToolCall } from "./session.js";
export { ClaudeCliConfig, ClaudeRequest, ClaudeResponse, Message, callClaude } from "./providers/claude-cli.js";
export { ToolDefinition } from "./agent.js";
export { ToolRegistry, createBuiltInRegistry } from "./tools/registry.js";
export { upgrade } from "./upgrade.js";
export type { UpgradeResult, UpgradeStep, CommandRunner } from "./upgrade.js";
