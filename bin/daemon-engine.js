#!/usr/bin/env node

/**
 * CLI entry point for daemon-engine.
 */

import { startDaemon } from "../dist/main.js";

// Parse command line arguments
const args = process.argv.slice(2);
let configPath = undefined;
let workspaceOverride = undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && i + 1 < args.length) {
    configPath = args[i + 1];
    i++;
  } else if (args[i] === "--workspace" && i + 1 < args.length) {
    workspaceOverride = args[i + 1];
    i++;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
daemon-engine - Agent-oriented runtime

Usage:
  daemon-engine [options]

Options:
  --config <path>      Path to config file (default: daemon.yaml or ~/.config/daemon-engine/daemon.yaml)
  --workspace <path>   Override workspace path from config
  --help, -h           Show this help message

Examples:
  daemon-engine                              # Start with default config
  daemon-engine --config /path/to/config.yaml
  daemon-engine --workspace ~/my-workspace
`);
    process.exit(0);
  }
}

// Start daemon
startDaemon(configPath)
  .catch((error) => {
    console.error(`[daemon-engine] Error: ${error.message}`);
    process.exit(1);
  });
