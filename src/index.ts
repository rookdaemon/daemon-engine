/**
 * index.ts — Main entry point for daemon-engine.
 *
 * Exports public API for the daemon engine runtime.
 */

export { Gateway, GatewayConfig, GatewayContext, HookConfig } from "./gateway.js";
export { SessionStore, FileSessionStore, SessionMessage, SessionMetadata, ToolCall } from "./session.js";
export { ClaudeCliConfig, ClaudeRequest, ClaudeResponse, callClaude } from "./providers/claude-cli.js";
export { ToolDefinition } from "./agent.js";
