# Observability API

The daemon-engine provides an observability API for external monitoring and diagnostics. This enables monitoring tools (like Doctor) to track runtime health, inspect logs, and diagnose issues.

## Overview

The observability API exposes four endpoints for monitoring:

- `GET /status` - Runtime information, uptime, model, version
- `GET /logs?lines=N` - Last N structured log entries
- `GET /history?limit=N` - Last N conversation messages
- `POST /diagnostic` - Run diagnostic checks (Agora format compatible)

## Configuration

Add an observability section to your daemon config to enable authentication:

```yaml
# daemon.yaml
observability:
  token: your-secret-bearer-token
```

If no `observability` section is provided, the endpoints are accessible without authentication (useful for local development).

## Authentication

All observability endpoints require Bearer token authentication when configured:

```bash
curl -H "Authorization: Bearer your-secret-bearer-token" \
  http://localhost:8080/status
```

If no token is configured in the daemon config, no authentication is required.

## Endpoints

### GET /status

Returns runtime information about the daemon instance.

**Response:**

```json
{
  "status": "running",
  "uptime": 3600,
  "version": "0.1.0",
  "model": "claude-sonnet-4",
  "startTime": "2026-02-05T08:48:53.985Z"
}
```

**Fields:**
- `status` - Current runtime status (always "running")
- `uptime` - Uptime in seconds
- `version` - Daemon engine version
- `model` - Model name being used
- `startTime` - ISO 8601 timestamp when daemon started

### GET /logs?lines=N

Returns the last N structured log entries. Default limit is 100 entries.

**Parameters:**
- `lines` (optional) - Number of log entries to return (default: 100)

**Response:**

```json
{
  "logs": [
    {
      "timestamp": "2026-02-05T08:48:54.123Z",
      "level": "info",
      "category": "workspace",
      "message": "Loaded SOUL.md (1024 bytes)",
      "data": {
        "file": "SOUL.md",
        "bytes": 1024,
        "success": true
      }
    },
    {
      "timestamp": "2026-02-05T08:48:55.456Z",
      "level": "info",
      "category": "model",
      "message": "API call to claude-sonnet-4 (1500ms, 100+50 tokens, $0.0010)",
      "data": {
        "model": "claude-sonnet-4",
        "inputTokens": 100,
        "outputTokens": 50,
        "cacheReadTokens": 25,
        "costUsd": 0.001,
        "durationMs": 1500,
        "sessionId": "session-123"
      }
    },
    {
      "timestamp": "2026-02-05T08:48:56.789Z",
      "level": "info",
      "category": "tool",
      "message": "Tool read executed successfully (50ms)",
      "data": {
        "name": "read",
        "success": true,
        "durationMs": 50
      }
    }
  ],
  "count": 3
}
```

**Log Categories:**
- `workspace` - Workspace file loading events
- `model` - Model API call events (with token usage and cost)
- `tool` - Tool invocation events
- `gateway` - Gateway request handling
- Other standard logging categories

**Log Levels:**
- `info` - Informational messages
- `warning` - Warning messages
- `error` - Error messages

### GET /history?limit=N

Returns the last N conversation messages across all sessions. Default limit is 10 messages.

**Parameters:**
- `limit` (optional) - Number of messages to return (default: 10)

**Response:**

```json
{
  "history": [
    {
      "sessionKey": "agora:default",
      "timestamp": 1738746534985,
      "role": "user",
      "content": "What's the status?"
    },
    {
      "sessionKey": "agora:default",
      "timestamp": 1738746535123,
      "role": "assistant",
      "content": "All systems operational."
    }
  ],
  "count": 2
}
```

**Fields:**
- `sessionKey` - Session identifier
- `timestamp` - Unix timestamp in milliseconds
- `role` - Message role (`user` or `assistant`)
- `content` - Message text content

### POST /diagnostic

Runs diagnostic checks and returns system health information. Accepts Agora diagnostic format for compatibility.

**Request:**

```json
{
  "checks": ["custom-check"]
}
```

**Response:**

```json
{
  "status": "ok",
  "checks": {
    "gateway": {
      "status": "healthy",
      "uptime": 3600
    },
    "sessions": {
      "count": 3
    },
    "logs": {
      "count": 1234
    },
    "custom-check": {
      "status": "not_implemented"
    }
  },
  "timestamp": "2026-02-05T08:48:53.985Z"
}
```

**Built-in Checks:**
- `gateway` - Gateway health and uptime
- `sessions` - Active session count
- `logs` - Log entry count

Custom checks in the request will return `"not_implemented"` status by default.

## Log Buffer

Logs are stored in a circular buffer with a maximum of 1000 entries. When the buffer is full, the oldest entries are removed as new ones are added.

This ensures bounded memory usage while maintaining recent diagnostic visibility.

## Use Cases

### External Monitoring

Doctor (monitoring agent) can poll `/status` and `/logs` to:
- Track daemon health and uptime
- Monitor model API usage and costs
- Detect errors and warnings
- Track tool invocation patterns

### Debugging

Developers can use `/logs` to:
- Inspect workspace file loading
- Track model API call performance
- Debug tool execution failures
- Monitor session behavior

### Session Analysis

Use `/history` to:
- Review recent conversations
- Analyze user/assistant interaction patterns
- Debug session routing issues

## Security Considerations

- Use a strong bearer token in production
- Keep the token in config file (not checked into version control)
- Consider using environment variable interpolation: `token: ${OBSERVABILITY_TOKEN}`
- The `/health` endpoint is always public (no auth required)

## Integration Example

Python monitoring script:

```python
import requests
import time

DAEMON_URL = "http://localhost:8080"
TOKEN = "your-secret-token"

def check_daemon_health():
    headers = {"Authorization": f"Bearer {TOKEN}"}
    
    # Get status
    status = requests.get(f"{DAEMON_URL}/status", headers=headers).json()
    print(f"Uptime: {status['uptime']}s, Model: {status['model']}")
    
    # Check recent logs for errors
    logs = requests.get(f"{DAEMON_URL}/logs?lines=50", headers=headers).json()
    errors = [log for log in logs['logs'] if log['level'] == 'error']
    
    if errors:
        print(f"Found {len(errors)} errors:")
        for error in errors:
            print(f"  {error['timestamp']}: {error['message']}")
    
    return len(errors) == 0

if __name__ == "__main__":
    while True:
        healthy = check_daemon_health()
        if not healthy:
            # Alert or take action
            pass
        time.sleep(60)  # Check every minute
```

## Related

- M2 dogfooding milestone
- Doctor monitoring agent
- Gateway usage documentation
