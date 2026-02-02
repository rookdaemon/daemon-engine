#!/usr/bin/env node
/**
 * main.ts — Entry point for daemon-engine runtime.
 *
 * Loads configuration, builds system prompts, creates HTTP server,
 * and starts the daemon engine. Handles CLI arguments and graceful shutdown.
 */

/* eslint-disable no-console */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { buildSystemPrompt } from "./workspace.js";
import { createServer } from "./gateway.js";
import { createAnthropicProvider } from "./provider.js";
import { startHeartbeat, stopHeartbeat, type HeartbeatHandle } from "./heartbeat.js";

/** Parse CLI arguments. */
function parseArgs(): { configDir?: string; port?: number } {
  const args = process.argv.slice(2);
  const result: { configDir?: string; port?: number } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      result.configDir = args[i + 1];
      i++;
    } else if (args[i] === "--port" && i + 1 < args.length) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return result;
}

/** Main entry point. */
async function main() {
  const args = parseArgs();

  // Load config
  const configDir = args.configDir || join(homedir(), ".daemon-engine");
  console.log(`Loading config from ${configDir}`);

  const config = await loadConfig(configDir);

  // Override port if specified via CLI
  if (args.port) {
    config.port = args.port;
  }

  console.log(`Loaded configuration with ${config.agents.length} agent(s)`);

  // Build system prompts for each agent
  for (const agent of config.agents) {
    const systemPrompt = await buildSystemPrompt(agent.workspace);
    console.log(
      `Built system prompt for agent "${agent.id}" (${systemPrompt.length} chars)`
    );
  }

  // Create Anthropic provider
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) {
    console.warn("Warning: No Anthropic API key found in config or environment");
  }
  const provider = createAnthropicProvider(apiKey);

  // Set up tool registry (empty for now)
  const tools = {};

  // Create HTTP server
  const server = createServer(config, { provider, tools });

  // Start heartbeat if configured
  let heartbeatHandle: HeartbeatHandle = null;
  if (config.heartbeat) {
    heartbeatHandle = startHeartbeat(config.heartbeat, () => {
      console.log("Heartbeat tick");
    });
    if (heartbeatHandle) {
      console.log(
        `Started heartbeat (interval: ${config.heartbeat.intervalSeconds}s)`
      );
    }
  }

  // Listen on configured port
  server.listen(config.port, () => {
    const model = config.agents[0]?.model || "none";
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                     Daemon Engine v0.1.0                   ║
╠════════════════════════════════════════════════════════════╣
║  Port:   ${config.port.toString().padEnd(48)} ║
║  Agents: ${config.agents.length.toString().padEnd(48)} ║
║  Model:  ${model.padEnd(48)} ║
╚════════════════════════════════════════════════════════════╝

Server is running. Press Ctrl+C to stop.
`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down gracefully...");

    // Stop heartbeat
    if (heartbeatHandle) {
      stopHeartbeat(heartbeatHandle);
      console.log("Stopped heartbeat");
    }

    // Close server
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
      console.error("Force closing after timeout");
      process.exit(1);
    }, 5000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Run main and handle errors
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
