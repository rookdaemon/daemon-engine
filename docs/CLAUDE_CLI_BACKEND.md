# Claude Backend Architecture

## Overview

daemon-engine supports three modes for Claude model inference:

1. **Claude CLI Mode (Billing Hack)** - Uses Claude Code CLI as the backend (default)
   - Leverages Claude Max subscription billing
   - Authenticated via Claude Code session token (pre-provisioned)
   - Built-in tools (Read, Write, Bash, Edit, WebFetch, WebSearch)
   - Session persistence via CLI's `--continue`/`--resume`
   - No API key required

2. **Claude API Mode (Direct)** - Uses Anthropic API directly
   - Direct API billing with Anthropic API key
   - Full programmatic control
   - Supports custom tool definitions
   - Standard Anthropic SDK integration

3. **Claude OAuth Mode (Session Token)** - Uses Anthropic API with OAuth session tokens
   - Claude Pro/Max subscription billing (via session token)
   - Session tokens from `claude setup-token` or OAuth flow run elsewhere
   - 1-to-1 with pi-mono session token flow (headers, identity prompt, tool names)
   - Supports credential store with automatic token refresh

## Configuration

Select between modes via the `provider.type` configuration:

```yaml
# Claude CLI Mode (default, billing hack)
provider:
  type: "claude-cli"
  model: "sonnet"  # or "opus", or full model identifier

# Claude API Mode (direct)
provider:
  type: "claude-api"
  model: "claude-3-5-sonnet-20241022"
  apiKey: "${ANTHROPIC_API_KEY}"  # or set in config
  maxTokens: 4096  # optional, default 4096

# Claude OAuth Mode (session token)
provider:
  type: "claude-oauth"
  model: "claude-3-5-sonnet-20241022"
  # Credential sources (priority order):
  # 1. sessionToken in config
  # 2. ANTHROPIC_OAUTH_TOKEN env var
  # 3. credentialStorePath JSON file (supports refresh)
  sessionToken: "sk-ant-oat01-..."  # optional
  credentialStorePath: "~/.config/daemon-engine/anthropic-oauth.json"  # optional
  maxTokens: 4096  # optional
```

## Mode Comparison

| Feature | CLI Mode | API Mode | OAuth Mode |
|---------|----------|----------|------------|
| **Billing** | Claude Code subscription | Anthropic API key | Claude Pro/Max subscription |
| **Auth** | Claude CLI session token | API key | OAuth session token (sk-ant-oat) |
| **Tools** | Built-in only (Read, Write, Bash, etc.) | Custom tool definitions | Custom with Claude Code canonical names |
| **Headless** | ✅ Yes (with --dangerously-skip-permissions) | ✅ Yes | ✅ Yes |
| **Token Required** | Yes (pre-provisioned via `claude login`) | API key | Session token or credential store |
| **Cost** | Fixed subscription | Per-token | Fixed subscription |

## Claude CLI Mode Architecture

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

## Claude API Mode Architecture

### Direct API Provider (`src/providers/claude-api.ts`)

Uses the official `@anthropic-ai/sdk` for direct API access.

```typescript
interface ClaudeApiConfig {
  apiKey: string;              // Anthropic API key
  model?: string;              // e.g., "claude-3-5-sonnet-20241022"
  retry?: RetryConfig;         // Retry configuration
  maxTokens?: number;          // Max tokens to generate (default: 4096)
}
```

**Key Features:**
- Full support for custom tool definitions via `toolDefinitions` parameter
- Streaming and non-streaming generation
- Automatic retry on transient errors (429, 503, 500)
- Tool call extraction and mapping
- Standard `ProviderResponse` format

**Usage:**

```typescript
import { ClaudeApiProvider } from "./providers/claude-api.js";

const provider = new ClaudeApiProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-3-5-sonnet-20241022",
  maxTokens: 4096,
});

const response = await provider.generate({
  messages: [{ role: "user", content: "Hello!" }],
  systemPrompt: "You are helpful",
  toolDefinitions: [/* custom tools */],
});
```

**Tool Definitions:**
Unlike CLI mode (which only supports built-in tools), API mode accepts custom tool definitions:

```typescript
toolDefinitions: [
  {
    name: "get_weather",
    description: "Get weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
]
```

### OAuth Provider (`src/providers/claude-oauth.ts`)

Uses OAuth session tokens with 1-to-1 behavior relative to pi-mono's Anthropic provider:

```typescript
interface ClaudeOAuthConfig {
  sessionToken?: string;       // Or ANTHROPIC_OAUTH_TOKEN env
  credentialStorePath?: string;  // For refresh support
  model?: string;
  retry?: RetryConfig;
  maxTokens?: number;
}
```

**Key Features:**
- `authToken` (not `apiKey`) when creating Anthropic client
- Claude Code stealth headers (`anthropic-dangerous-direct-browser-access`, `anthropic-beta`, `user-agent`, `x-app`)
- Claude Code identity system prompt prepended to requests
- Tool name conversion: registry names → Claude Code canonical (Read, Write, Edit, Bash, WebSearch, etc.)
- Credential store with automatic token refresh when expired

## Headless Operation

Both modes support headless (non-interactive) operation:

### CLI Mode
- Requires pre-authentication: `claude login` (one-time setup)
- Use `--dangerously-skip-permissions` flag to auto-approve file/shell operations
- Session token is stored by Claude CLI in `~/.config/claude/`
- Configure via `claude.skipPermissions: true` in daemon.yaml

### API Mode
- Requires `ANTHROPIC_API_KEY` environment variable or `provider.apiKey` config
- No browser login required
- Fully programmatic

### OAuth Mode
- Session tokens come from `claude setup-token` (run on any machine) or OAuth flow run elsewhere
- Credential sources (priority): `provider.sessionToken` → `ANTHROPIC_OAUTH_TOKEN` env → credential store file
- Credential store format: `{ refresh, access, expires }` — tokens are refreshed automatically when expired
- Default store path: `~/.config/daemon-engine/anthropic-oauth.json` (or `$OPENCLAW_STATE_DIR/daemon-engine/anthropic-oauth.json`)

## Migration Path

### From CLI Mode to API Mode

1. **Get an Anthropic API key:**
   ```bash
   # Sign up at console.anthropic.com
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

2. **Update configuration:**
   ```yaml
   provider:
     type: "claude-api"  # Changed from "claude-cli"
     apiKey: "${ANTHROPIC_API_KEY}"
     model: "claude-3-5-sonnet-20241022"
   ```

3. **Handle tool differences:**
   - CLI built-in tools (Read, Write, Bash) → Use daemon-engine's built-in tools via `toolDefinitions`
   - Custom tools are now fully supported

### From API Mode to CLI Mode

1. **Authenticate with Claude CLI:**
   ```bash
   claude login
   ```

2. **Update configuration:**
   ```yaml
   provider:
     type: "claude-cli"  # Changed from "claude-api"
     model: "sonnet"
   claude:
     skipPermissions: true
   ```

3. **Remove custom toolDefinitions:**
   - API custom tools → CLI built-in tools only
   - Use `--tools` flag to select which built-in tools to enable

### From API Mode to OAuth Mode (Session Token)

1. **Obtain a session token:**
   ```bash
   # Run on any machine (interactive)
   claude setup-token
   # Copy the printed token (sk-ant-oat01-...)
   ```

2. **Update configuration:**
   ```yaml
   provider:
     type: "claude-oauth"
     sessionToken: "sk-ant-oat01-..."  # Or set ANTHROPIC_OAUTH_TOKEN env
     model: "claude-3-5-sonnet-20241022"
   ```

3. **Or use credential store with refresh:**
   - Create JSON file at `~/.config/daemon-engine/anthropic-oauth.json` with `{ refresh, access, expires }`
   - Set `provider.credentialStorePath` or use default path
   - Tokens are refreshed automatically when expired

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
