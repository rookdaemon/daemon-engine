# HTTP Gateway Usage Guide

The HTTP Gateway provides a server for receiving webhooks and routing messages to Claude CLI sessions.

## Quick Start

```typescript
import { Gateway, FileSessionStore } from "@rookdaemon/daemon-engine";

// Configure the gateway
const gateway = new Gateway(
  {
    port: 8080,
    host: "0.0.0.0",
    hooks: {
      agora: {
        token: "your-secret-token-here",
        sessionKey: "agora:default",
      },
      discord: {
        token: "discord-webhook-token",
        sessionKey: "discord:main",
      },
    },
    systemPrompt: "You are a helpful AI assistant.", // optional
  },
  {
    workspaceDir: process.cwd(),
    claudeConfig: {
      model: "sonnet",
      skipPermissions: true,
    },
    sessionStore: new FileSessionStore("./state/sessions"),
    onResponse: async (sessionKey, response) => {
      // Optional: handle outbound routing
      console.log(`Response for ${sessionKey}: ${response}`);
    },
  }
);

// Start the server
await gateway.start();
console.log(`Gateway listening on port ${gateway.getPort()}`);

// Stop the server when done
process.on("SIGTERM", async () => {
  await gateway.stop();
  process.exit(0);
});
```

## Endpoints

### POST /hooks

Receive webhooks from external services.

**Request:**
```bash
curl -X POST http://localhost:8080/hooks \
  -H "Authorization: Bearer your-secret-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agora",
    "payload": {
      "from": "user123",
      "message": "Hello, bot!"
    }
  }'
```

**Response:**
```json
{
  "status": "ok",
  "response": "Hello! How can I help you today?",
  "sessionKey": "agora:default"
}
```

### POST /message

Direct message injection (for webchat/testing).

**Request:**
```bash
curl -X POST http://localhost:8080/message \
  -H "Authorization: Bearer your-secret-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agora:default",
    "message": "What is the weather like?"
  }'
```

**Response:**
```json
{
  "status": "ok",
  "response": "I don't have access to real-time weather data...",
  "sessionKey": "agora:default"
}
```

### GET /health

Health check endpoint (no authentication required).

**Request:**
```bash
curl http://localhost:8080/health
```

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "0.1.0"
}
```

## Configuration

### GatewayConfig

- **port** (number): Port to listen on. Default: 8080. Use 0 to let OS assign a port.
- **host** (string, optional): Host to bind to. Default: "0.0.0.0"
- **hooks** (Record<string, HookConfig>): Webhook configurations by type
- **systemPrompt** (string, optional): System prompt for Claude CLI. Default: "You are a helpful AI assistant."

### HookConfig

- **token** (string): Bearer token for authentication
- **sessionKey** (string): Session key to route messages to (e.g., "agora:default")

### GatewayContext

- **workspaceDir** (string): Working directory for Claude CLI operations
- **claudeConfig** (ClaudeCliConfig): Configuration for Claude CLI invocation
- **sessionStore** (SessionStore): Session store for managing conversation history
- **onResponse** ((sessionKey: string, response: string) => Promise<void>, optional): Callback for handling agent responses

## Message Payload Formats

The gateway supports flexible message extraction from various payload formats:

```json
// Using "message" field
{ "message": "Hello" }

// Using "text" field
{ "text": "Hello" }

// Using "content" field
{ "content": "Hello" }

// Complex payload
{
  "from": "user123",
  "timestamp": 1234567890,
  "message": "Hello"
}
```

## Session Management

Sessions are managed by the SessionStore and maintain conversation history:

- Each session is identified by a sessionKey (e.g., "agora:default", "discord:main")
- History is automatically included in Claude CLI prompts for context
- Sessions are stored in JSONL format for efficient append operations
- Metadata tracks session activity and compaction count

## Error Handling

The gateway returns appropriate HTTP status codes:

- **200 OK**: Request processed successfully
- **400 Bad Request**: Invalid request body (missing required fields)
- **401 Unauthorized**: Missing or invalid Bearer token
- **404 Not Found**: Unknown hook type or session
- **500 Internal Server Error**: Server-side error during processing

## Security

- All protected endpoints require Bearer token authentication
- Each hook type has its own token for isolation
- Tokens are verified using constant-time comparison
- GET /health is the only endpoint that doesn't require authentication

## Testing

Run the test suite to verify gateway functionality:

```bash
npm test -- gateway.test.ts
```

The test suite covers:
- Server start/stop lifecycle
- Authentication and authorization
- All endpoint responses
- Session continuity
- Custom system prompts
- Error handling
