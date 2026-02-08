# Daemon Engine - Capability Inventory

This document provides a structured inventory of daemon-engine's current capabilities as of 2026-02-03.

## Capability: Environment Abstraction
Location: src/env/environment.ts
Status: Implemented
Description: Centralizes all side-effectful operations behind interfaces for platform-specific behavior and deterministic tests.
Notes:
- Provides: fs, clock, process, os, path, subprocess, shell, http
- **Time and clock injection:** Time is accessed only via `env.clock.now()`. Never use `Date.now()` directly. Pass `now` into function calls so everything stays on the same tick; tests inject known timestamps
- **Delays/timers:** Use `env.process.setTimeout` so tests can substitute a fake scheduler (`vi.useFakeTimers()`)
- Production: `createNodeEnvironment()` uses real Node.js APIs
- Tests: Inject mock Environment with controllable clock and no real I/O

## Capability: Tool System
Location: src/agent.ts, src/tools/
Status: Implemented
Description: Core tool interface and execution system allowing agents to call typed async functions.
Notes: 
- ToolDefinition interface defines standard structure for tools (description, parameters schema, execute function)
- Three tools currently implemented: read, write, exec
- Tools accept typed parameters with JSON Schema validation
- All tools return Promise<string> results

### Tool: Read
Location: src/tools/read.ts
Status: Implemented
Description: Read file contents (text) or list directory entries
Notes:
- Takes single parameter: absolute path
- Returns file content for files, newline-separated list for directories
- Uses node:fs/promises (readFile, readdir, stat)

### Tool: Write
Location: src/tools/write.ts
Status: Implemented
Description: Create or overwrite files with given content
Notes:
- Takes path and content parameters
- Creates parent directories if needed (recursive mkdir)
- Overwrites file if it already exists
- Returns confirmation message with byte count

### Tool: Exec
Location: src/tools/exec.ts
Status: Implemented
Description: Execute shell commands with timeout
Notes:
- Takes command, optional args, cwd, and timeout parameters
- Default timeout: 30000ms (30 seconds)
- Uses node:child_process execFile with promisify
- Returns stdout, appends stderr if present
- 10MB max buffer size
- Throws error with stdout/stderr on command failure

## Capability: Workspace Model
Location: src/workspace.ts
Status: Implemented
Description: Reads workspace personality files and assembles system prompt from markdown files
Notes:
- Compatible with OpenClaw workspace format
- Reads files in order: SOUL.md, AGENTS.md, USER.md, MEMORY.md, TOOLS.md, HEARTBEAT.md
- Missing files are silently skipped (no errors)
- Each present file included with `## filename` header
- Returns assembled system prompt as single string
- Uses node:fs/promises readFile and node:path join

## Capability: Config System
Location: src/config.ts
Status: Implemented
Description: Load and validate configuration from YAML or JSON files
Notes:
- Reads config from specified path (e.g., ~/.daemon-engine/config.yaml)
- Supports both YAML and JSON formats
- Interpolates environment variables using ${ENV_VAR} syntax
- Validates config structure with clear error messages
- Config includes:
  - model: provider (anthropic|openai), name, apiKey
  - workspace: path to workspace directory
  - server: port number for HTTP server
- Uses js-yaml dependency (only production dependency in package.json)
- Fails fast with clear errors for missing/invalid config

## Capability: Session Management
Location: (planned) src/session.ts
Status: Missing
Description: Would handle session state and transcript persistence
Notes:
- Mentioned in DESIGN.md architecture
- Planned to use JSONL format for transcripts
- Not yet implemented in codebase

## Capability: Channel Routing
Location: (planned) src/router.ts, src/channels/
Status: Missing
Description: Would route messages to appropriate sessions and handle channel-specific communication
Notes:
- Mentioned in DESIGN.md architecture
- Planned channels: webchat, discord, telegram, signal
- Message → session routing not yet implemented
- No channel implementations exist in current codebase

## Capability: Webhooks & Inbound
Location: (planned) src/gateway.ts
Status: Missing
Description: Would provide HTTP server entry point for receiving messages
Notes:
- Mentioned in DESIGN.md as main entry point
- Would handle HTTP server + main loop
- Not yet implemented in codebase
- Server config exists in config system (server.port) but no server implementation

## Capability: Heartbeat System
Location: (planned) src/heartbeat.ts
Status: Missing
Description: Would handle heartbeat/cron scheduling for periodic tasks
Notes:
- Mentioned in DESIGN.md architecture
- Workspace module includes HEARTBEAT.md in file list
- No implementation exists yet

## Capability: Gateway Control
Location: (planned) src/gateway.ts
Status: Missing
Description: Would serve as main entry point with HTTP server and core loop
Notes:
- Mentioned in DESIGN.md as entry point
- Would implement: receive message → router → workspace → agent → tools → session → channel
- Not yet implemented

## Summary

**Implemented Capabilities:**
- Tool System (core interface + 3 tools: read, write, exec)
- Workspace Model (personality file loading)
- Config System (YAML/JSON with validation)

**Missing Capabilities:**
- Session Management
- Channel Routing
- Webhooks & Inbound handling
- Heartbeat System
- Gateway Control

**Current State:**
The codebase contains foundational building blocks (tools, workspace loading, config) but lacks the runtime infrastructure (gateway, sessions, channels, routing) needed for a complete agent platform. The DESIGN.md shows the intended architecture, but only ~25% of planned modules are implemented.
