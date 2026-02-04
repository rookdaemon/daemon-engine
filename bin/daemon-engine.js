#!/usr/bin/env node

/**
 * CLI entry point for daemon-engine.
 */

import { startDaemon, startChatMode } from '../dist/main.js';

// Parse command line arguments
const args = process.argv.slice(2);

// Determine subcommand
const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'start';
const commandArgs = subcommand === args[0] ? args.slice(1) : args;

let configPath = undefined;
let sessionKey = 'main';

for (let i = 0; i < commandArgs.length; i++) {
  if (commandArgs[i] === '--config' && i + 1 < commandArgs.length) {
    configPath = commandArgs[i + 1];
    i++;
  } else if (commandArgs[i] === '--session' && i + 1 < commandArgs.length) {
    sessionKey = commandArgs[i + 1];
    i++;
  } else if (commandArgs[i] === '--help' || commandArgs[i] === '-h') {
    console.log(`
daemon-engine - Agent-oriented runtime

Usage:
  daemon-engine start [options]    Start the daemon (gateway + heartbeat)
  daemon-engine chat [options]     Start interactive chat mode

Options:
  --config <path>      Path to config file (default: daemon.yaml or ~/.config/daemon-engine/daemon.yaml)
  --session <key>      Session key for chat mode (default: "main")
  --help, -h           Show this help message

Examples:
  daemon-engine start                           # Start daemon with default config
  daemon-engine start --config /path/to/config.yaml
  daemon-engine chat                            # Start interactive chat
  daemon-engine chat --session dev              # Chat with custom session key
`);
    process.exit(0);
  }
}

// Execute subcommand
if (subcommand === 'start') {
  startDaemon(configPath)
    .catch((error) => {
      console.error(`[daemon-engine] Error: ${error.message}`);
      process.exit(1);
    });
} else if (subcommand === 'chat') {
  startChatMode(configPath, sessionKey)
    .catch((error) => {
      console.error(`[daemon-engine] Error: ${error.message}`);
      process.exit(1);
    });
} else {
  console.error(`[daemon-engine] Unknown subcommand: ${subcommand}`);
  console.error('Use --help to see available commands');
  process.exit(1);
}

