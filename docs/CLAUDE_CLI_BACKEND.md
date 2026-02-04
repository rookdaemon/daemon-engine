# Claude CLI Backend Architecture

## Overview

daemon-engine uses Claude Code CLI as its inference backend instead of direct API calls. This provides:
- Legitimate Max subscription usage (CLI is supported use case)
- Built-in tools (Read, Write, Bash, Edit, WebFetch, WebSearch)
- OAuth handling managed by Claude CLI
- Session persistence via CLI's `--continue`/`--resume`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      daemon-engine                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │ Gateway │  │ Heartbeat│  │  Router   │  │  Session   │  │
│  │  :8080  │  │  Timer   │  │           │  │  Store     │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └─────┬──────┘  │
│       │            │              │              │          │
│       └────────────┴──────────────┴──────────────┘          │
│                           │                                  │
│                    ┌──────┴──────┐                          │
│                    │ Claude CLI  │                          │
│                    │  Wrapper    │                          │
│                    └──────┬──────┘                          │
└───────────────────────────┼─────────────────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  claude -p    │
                    │  subprocess   │
                    └───────────────┘
```

## Components

### 1. Claude CLI Wrapper (`src/providers/claude-cli.ts`)

Spawns Claude Code CLI in print mode, handles I/O.

```typescript
interface ClaudeCliConfig {
  model?: string;              // 'opus', 'sonnet', or full model name
  tools?: string[];            // ['Bash', 'Read', 'Write', 'Edit']
  skipPermissions?: boolean;   // --dangerously-skip-permissions
  timeout?: number;            // Kill after N seconds
}

interface ClaudeRequest {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;          // For --continue
}

interface ClaudeResponse {
  type: 'success' | 'error';
  result: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  };
  sessionId: string;
  durationMs: number;
}

async function callClaude(request: ClaudeRequest, config: ClaudeCliConfig): Promise<ClaudeResponse>;
async function streamClaude(request: ClaudeRequest, config: ClaudeCliConfig): AsyncGenerator<ClaudeEvent>;
```

**Implementation notes:**
- Use `spawn('claude', [...])` with stdin/stdout pipes
- `--output-format json` for simple calls
- `--output-format stream-json --verbose` for streaming
- Parse NDJSON lines from stdout
- Handle stderr for errors
- Set `--dangerously-skip-permissions` for automated operation

### 2. Workspace Loader (`src/workspace.ts`) — EXISTS

Loads workspace context files into system prompt.

```typescript
function loadWorkspaceContext(workspaceDir: string): string {
  // Load in order, concatenate
  const files = [
    'SOUL.md',
    'AGENTS.md', 
    'MEMORY.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
  ];
  return files.map(f => readIfExists(join(workspaceDir, f))).join('\n\n');
}
```

### 3. Heartbeat Runner (`src/heartbeat.ts`)

Periodic execution loop.

```typescript
interface HeartbeatConfig {
  intervalMs: number;          // Default: 120000 (2 min)
  prompt: string;              // Default: "Read HEARTBEAT.md..."
  activeHours?: [number, number]; // [startHour, endHour] UTC
}

class HeartbeatRunner {
  private timer: NodeJS.Timeout | null = null;
  
  start(config: HeartbeatConfig, onBeat: () => Promise<void>): void;
  stop(): void;
}
```

**Flow:**
1. Timer fires
2. Load workspace context as system prompt
3. Call Claude CLI with heartbeat prompt
4. If response is not "HEARTBEAT_OK", log to daily notes
5. Optionally route response to channel

### 4. Gateway (`src/gateway.ts`)

HTTP server for webhooks and control.

```typescript
interface GatewayConfig {
  port: number;                // Default: 8080
  hooks: {
    [type: string]: {
      token: string;           // Bearer token for auth
      route: string;           // Session key pattern
    }
  }
}

// Endpoints:
// POST /hooks          - Receive webhook (Agora, Discord, etc.)
// POST /message        - Direct message injection
// GET  /health         - Health check
// POST /control/stop   - Graceful shutdown
```

### 5. Session Store (`src/session.ts`) — EXISTS

JSONL transcript storage.

```typescript
interface SessionStore {
  append(sessionKey: string, message: Message): Promise<void>;
  getHistory(sessionKey: string, limit?: number): Promise<Message[]>;
  getMetadata(sessionKey: string): Promise<SessionMetadata>;
}
```

### 6. Router (`src/router.ts`)

Routes messages between gateway and sessions.

```typescript
interface Router {
  // Inbound: webhook → session
  routeInbound(hookType: string, payload: unknown): Promise<string>;
  
  // Outbound: session response → channel
  routeOutbound(sessionKey: string, response: string): Promise<void>;
}
```

## Configuration

```yaml
# daemon.yaml
workspace: ~/.openclaw/workspace

claude:
  model: opus                    # or 'sonnet', or full model name
  skipPermissions: true          # for automated operation
  timeout: 300                   # 5 min max per call

heartbeat:
  enabled: true
  intervalMs: 1800000            # 30 min
  prompt: "Read HEARTBEAT.md if it exists. Follow it strictly."

gateway:
  port: 8080
  hooks:
    agora:
      token: ${AGORA_HOOK_TOKEN}
      route: "agora:default"
    webchat:
      token: ${WEBCHAT_TOKEN}
      route: "webchat:main"

sessions:
  storeDir: ./state/sessions
  transcriptFormat: jsonl
```

## Startup Flow

```
1. Load config (daemon.yaml + env vars)
2. Initialize session store
3. Load workspace context
4. Start heartbeat timer
5. Start gateway HTTP server
6. Log "daemon-engine started"
```

## Message Flow (Inbound)

```
1. Webhook arrives at POST /hooks
2. Verify bearer token
3. Parse payload, extract message
4. Load session history (if continuing)
5. Build prompt: context + history + message
6. Call Claude CLI
7. Parse response
8. Append to session transcript
9. Route response to outbound channel (if configured)
10. Return response to webhook caller
```

## Differences from OpenClaw

| Feature | OpenClaw | daemon-engine |
|---------|----------|---------------|
| Model backend | pi-ai (direct API) | Claude CLI subprocess |
| Tools | Custom implementations | Claude CLI built-in |
| Channels | Plugin system | Simple webhook routing |
| Session | Complex state machine | JSONL transcripts |
| Auth | OAuth token extraction | CLI handles it |

## Migration Path

1. **Phase 1**: Core runtime (CLI wrapper + heartbeat + gateway)
2. **Phase 2**: Session continuity (history loading, compaction)
3. **Phase 3**: Channel adapters (Discord, Agora, etc.)
4. **Phase 4**: Advanced features (cron, memory search, etc.)

## Tool Handling

Claude CLI has built-in tools. We use them directly:
- `Read` - File reading
- `Write` - File writing  
- `Edit` - File editing
- `Bash` - Command execution
- `Glob` - File pattern matching
- `Grep` - Text search
- `WebFetch` - HTTP requests
- `WebSearch` - Web search

**Custom tools** (like Agora, message, cron) would need to be:
- Implemented as MCP servers, OR
- Handled at the gateway level (intercept tool calls from response)

For MVP, rely on CLI built-in tools only.
