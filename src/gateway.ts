/**
 * gateway.ts — HTTP gateway server for webhook routing to Claude CLI sessions.
 *
 * Receives webhooks from external services (Agora, Discord, etc.), authenticates
 * them, and routes messages to appropriate Claude CLI sessions via session store.
 */

import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { ClaudeCliConfig, callClaude, callClaudeStream, StreamEvent, Message } from "./providers/claude-cli.js";
import { SessionStore, SessionMessage } from "./session.js";
import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";
import { buildSystemPromptWithEnv, SystemPromptOptions } from "./workspace.js";
import { log } from "./logger.js";
import { observability } from "./observability.js";

/**
 * Configuration for a webhook hook.
 */
export interface HookConfig {
  /** Bearer token for authentication. */
  token: string;
  /** Session key to route messages to (e.g., "agora:default"). */
  sessionKey: string;
}

/**
 * Configuration for the gateway server.
 */
export interface GatewayConfig {
  /** Port to listen on. Default: 8080. */
  port: number;
  /** Host to bind to. Default: "0.0.0.0". */
  host?: string;
  /** Hook configurations: hookType -> config. */
  hooks: Record<string, HookConfig>;
  /** Optional bearer token for observability endpoints. */
  observabilityToken?: string;
  /** Model name for status reporting. */
  modelName?: string;
  /** Version string for status reporting (e.g. "0.1.0+abc1234"). */
  version?: string;
}

/**
 * Context dependencies for gateway operation.
 */
export interface GatewayContext {
  /** Working directory for Claude CLI operations. */
  workspaceDir: string;
  /** Configuration for Claude CLI invocation. */
  claudeConfig: ClaudeCliConfig;
  /** Session store for managing conversation history. */
  sessionStore: SessionStore;
  /** Optional callback for handling agent responses (for outbound routing). */
  onResponse?: (sessionKey: string, response: string) => Promise<void>;
  /** Maximum context tokens before triggering session reset (default: 150000). */
  maxContextTokens?: number;
  /** Options for building the system prompt. */
  promptOptions: SystemPromptOptions;
}

/**
 * HTTP Gateway server for receiving webhooks and routing to Claude CLI sessions.
 */
export class Gateway {
  private server: Server | null = null;
  private startTime: number = 0;
  private config: GatewayConfig;
  private context: GatewayContext;
  private env: Environment;

  constructor(
    config: GatewayConfig,
    context: GatewayContext,
    env: Environment = createNodeEnvironment()
  ) {
    this.config = config;
    this.context = context;
    this.env = env;
  }

  /**
   * Start the gateway server.
   */
  async start(): Promise<void> {
    if (this.server) {
      throw new Error("Gateway server is already running");
    }

    this.startTime = this.env.clock.now();
    
    this.server = this.env.http.createServer(async (req, res) => {
      await this.handleRequest(req, res);
    });

    const host = this.config.host || "0.0.0.0";
    const port = this.config.port;

    const server = this.server;
    if (!server) {
      throw new Error("Gateway server not initialized");
    }

    return new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => resolve());
      server.on("error", (error) => reject(error));
    });
  }

  /**
   * Stop the gateway server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    return new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  /**
   * Get the current server port.
   * 
   * Returns the actual listening port, which may differ from the configured
   * port if it was set to 0 (allowing the OS to assign a port).
   */
  getPort(): number {
    if (this.server && this.server.listening) {
      const address = this.server.address();
      if (address && typeof address !== "string") {
        return address.port;
      }
    }
    return this.config.port;
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    try {
      // Health endpoint (no auth required)
      if (method === "GET" && url === "/health") {
        await this.handleHealth(req, res);
        return;
      }

      // Observability endpoints (require auth if observability is enabled)
      if (method === "GET" && url === "/status") {
        await this.handleStatus(req, res);
        return;
      }

      if (method === "GET" && url?.startsWith("/logs")) {
        await this.handleLogs(req, res);
        return;
      }

      if (method === "GET" && url?.startsWith("/history")) {
        await this.handleHistory(req, res);
        return;
      }

      // GET /sessions/:key/messages endpoint
      if (method === "GET" && url?.startsWith("/sessions/")) {
        const match = url.match(/^\/sessions\/([^/]+)\/messages/);
        if (match) {
          await this.handleSessionMessages(req, res, match[1]);
          return;
        }
      }

      if (method === "POST" && url === "/diagnostic") {
        await this.handleDiagnostic(req, res);
        return;
      }

      // POST /hooks endpoint
      if (method === "POST" && url === "/hooks") {
        await this.handleHooks(req, res);
        return;
      }

      // POST /message endpoint
      if (method === "POST" && url === "/message") {
        await this.handleMessage(req, res);
        return;
      }

      // POST /stream endpoint
      if (method === "POST" && url === "/stream") {
        await this.handleStream(req, res);
        return;
      }

      // POST /session/reset endpoint
      if (method === "POST" && url === "/session/reset") {
        await this.handleSessionReset(req, res);
        return;
      }

      // 404 for unknown routes
      this.sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      log.error("[gateway]", `Error handling request: ${error instanceof Error ? error.message : String(error)}`);
      this.sendJson(res, 500, { 
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Handle GET /health endpoint.
   */
  private async handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const uptime = Math.floor((this.env.clock.now() - this.startTime) / 1000);

    this.sendJson(res, 200, {
      status: "healthy",
      uptime,
      version: this.config.version || "0.1.0",
    });
  }

  /**
   * Handle GET /status endpoint.
   */
  private async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify observability auth
    if (!this.verifyObservabilityAuth(req, res)) {
      return;
    }

    const uptime = Math.floor((this.env.clock.now() - this.startTime) / 1000);
    
    this.sendJson(res, 200, {
      status: "running",
      uptime,
      version: this.config.version || "0.1.0",
      model: this.config.modelName || "unknown",
      startTime: new Date(this.startTime).toISOString(),
    });
  }

  /**
   * Handle GET /logs endpoint.
   */
  private async handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify observability auth
    if (!this.verifyObservabilityAuth(req, res)) {
      return;
    }

    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const linesParam = url.searchParams.get("lines");
    const lines = linesParam ? parseInt(linesParam, 10) : 100;

    if (isNaN(lines) || lines <= 0) {
      this.sendJson(res, 400, { error: "Invalid 'lines' parameter" });
      return;
    }

    const logs = observability.getLogs(lines);
    
    this.sendJson(res, 200, {
      logs,
      count: logs.length,
    });
  }

  /**
   * Handle GET /history endpoint.
   */
  private async handleHistory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify observability auth
    if (!this.verifyObservabilityAuth(req, res)) {
      return;
    }

    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 10;

    if (isNaN(limit) || limit <= 0) {
      this.sendJson(res, 400, { error: "Invalid 'limit' parameter" });
      return;
    }

    // Get all sessions
    const sessionKeys = await this.context.sessionStore.list();
    
    // Collect history from all sessions
    const history: Array<{
      sessionKey: string;
      timestamp: number;
      role: "user" | "assistant";
      content: string | null;
    }> = [];

    for (const sessionKey of sessionKeys) {
      const messages = await this.context.sessionStore.load(sessionKey);
      
      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          history.push({
            sessionKey,
            timestamp: msg.timestamp,
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    // Sort by timestamp descending and take last N
    history.sort((a, b) => b.timestamp - a.timestamp);
    const recentHistory = history.slice(0, limit);

    this.sendJson(res, 200, {
      history: recentHistory,
      count: recentHistory.length,
    });
  }

  /**
   * Handle GET /sessions/:key/messages endpoint.
   * 
   * Returns paginated message history for a specific session.
   * Query parameters:
   * - limit: Number of messages to return (default: 50, max: 100)
   * - before: Timestamp cursor for pagination (returns messages before this timestamp)
   * - include: "tools" to include tool call/result messages (default: user/assistant only)
   */
  private async handleSessionMessages(
    req: IncomingMessage,
    res: ServerResponse,
    sessionKey: string
  ): Promise<void> {
    // Verify observability auth
    if (!this.verifyObservabilityAuth(req, res)) {
      return;
    }

    // Decode sessionKey from URL encoding
    const decodedSessionKey = decodeURIComponent(sessionKey);

    // Check if session exists
    const metadata = await this.context.sessionStore.getMetadata(decodedSessionKey);
    if (!metadata) {
      this.sendJson(res, 404, { error: `Session not found: ${decodedSessionKey}` });
      return;
    }

    // Parse query parameters
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const limitParam = url.searchParams.get("limit");
    const beforeParam = url.searchParams.get("before");
    const includeParam = url.searchParams.get("include");

    // Validate limit parameter
    let limit = limitParam ? parseInt(limitParam, 10) : 50;
    if (isNaN(limit) || limit <= 0) {
      this.sendJson(res, 400, { error: "Invalid 'limit' parameter" });
      return;
    }
    if (limit > 100) {
      limit = 100; // Cap at 100
    }

    // Validate before parameter
    let beforeTimestamp: number | null = null;
    if (beforeParam) {
      beforeTimestamp = parseInt(beforeParam, 10);
      if (isNaN(beforeTimestamp) || beforeTimestamp <= 0) {
        this.sendJson(res, 400, { error: "Invalid 'before' parameter" });
        return;
      }
    }

    // Check if we should include tool messages
    const includeTools = includeParam === "tools";

    // Load all messages from the session
    const allMessages = await this.context.sessionStore.load(decodedSessionKey);

    // Filter messages based on role
    let messages = allMessages.filter((msg) => {
      if (includeTools) {
        // Include all messages
        return true;
      } else {
        // Only include user and assistant messages
        return msg.role === "user" || msg.role === "assistant";
      }
    });

    // Filter by beforeTimestamp if provided
    if (beforeTimestamp !== null) {
      messages = messages.filter((msg) => msg.timestamp < beforeTimestamp);
    }

    // Sort by timestamp descending (newest first)
    messages.sort((a, b) => b.timestamp - a.timestamp);

    // Take only the requested number of messages
    const paginatedMessages = messages.slice(0, limit);

    // Return the result
    this.sendJson(res, 200, {
      messages: paginatedMessages,
      count: paginatedMessages.length,
      sessionKey: decodedSessionKey,
    });
  }

  /**
   * Handle POST /diagnostic endpoint.
   */
  private async handleDiagnostic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify observability auth
    if (!this.verifyObservabilityAuth(req, res)) {
      return;
    }

    // Parse request body
    const body = await this.parseBody(req);

    // Run diagnostic checks
    const checks: Record<string, unknown> = {
      gateway: {
        status: "healthy",
        uptime: Math.floor((this.env.clock.now() - this.startTime) / 1000),
      },
      sessions: {
        count: (await this.context.sessionStore.list()).length,
      },
      logs: {
        count: observability.getAllLogs().length,
      },
    };

    // Add any custom checks from the request
    if (body.checks && Array.isArray(body.checks)) {
      for (const check of body.checks) {
        if (typeof check === "string") {
          // Add custom check results based on check name
          checks[check] = { status: "not_implemented" };
        }
      }
    }

    this.sendJson(res, 200, {
      status: "ok",
      checks,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Verify observability authentication.
   * Returns true if auth is valid, false otherwise (and sends 401 response).
   */
  private verifyObservabilityAuth(req: IncomingMessage, res: ServerResponse): boolean {
    // If no observability token is configured, allow access
    if (!this.config.observabilityToken) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (!this.verifyAuth(authHeader, this.config.observabilityToken)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return false;
    }

    return true;
  }

  /**
   * Handle POST /hooks endpoint.
   */
  private async handleHooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse request body
    const body = await this.parseBody(req);
    
    // Extract hook type and payload
    const type = body.type;
    const payload = body.payload;
    
    if (typeof type !== "string" || !payload || typeof payload !== "object") {
      this.sendJson(res, 400, { error: "Missing 'type' or 'payload' in request body" });
      return;
    }

    // Look up hook configuration
    const hookConfig = this.config.hooks[type];
    if (!hookConfig) {
      this.sendJson(res, 404, { error: `Unknown hook type: ${type}` });
      return;
    }

    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!this.verifyAuth(authHeader, hookConfig.token)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Extract message from payload
    const message = this.extractMessage(payload as Record<string, unknown>);
    
    // Process the webhook
    const response = await this.processMessage(hookConfig.sessionKey, message);

    // Return response
    this.sendJson(res, 200, {
      status: "ok",
      response,
      sessionKey: hookConfig.sessionKey,
    });
  }

  /**
   * Handle POST /message endpoint.
   */
  private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse request body
    const body = await this.parseBody(req);
    
    const sessionKey = body.sessionKey;
    const message = body.message;
    
    if (typeof sessionKey !== "string" || typeof message !== "string") {
      this.sendJson(res, 400, { error: "Missing 'sessionKey' or 'message' in request body" });
      return;
    }

    // For direct messages, we need to find a matching hook config to verify auth
    // Look for any hook with this sessionKey
    let foundToken: string | null = null;
    for (const hookConfig of Object.values(this.config.hooks)) {
      if (hookConfig.sessionKey === sessionKey) {
        foundToken = hookConfig.token;
        break;
      }
    }

    if (!foundToken) {
      this.sendJson(res, 404, { error: `No hook configured for session: ${sessionKey}` });
      return;
    }

    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!this.verifyAuth(authHeader, foundToken)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Process the message
    const response = await this.processMessage(sessionKey, message);

    // Return response
    this.sendJson(res, 200, {
      status: "ok",
      response,
      sessionKey,
    });
  }

  /**
   * Handle POST /stream endpoint with SSE.
   */
  private async handleStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse request body
    const body = await this.parseBody(req);
    
    const sessionKey = body.sessionKey;
    const message = body.message;
    
    if (typeof sessionKey !== "string" || typeof message !== "string") {
      this.sendJson(res, 400, { error: "Missing 'sessionKey' or 'message' in request body" });
      return;
    }

    // For direct messages, we need to find a matching hook config to verify auth
    // Look for any hook with this sessionKey
    let foundToken: string | null = null;
    for (const hookConfig of Object.values(this.config.hooks)) {
      if (hookConfig.sessionKey === sessionKey) {
        foundToken = hookConfig.token;
        break;
      }
    }

    if (!foundToken) {
      this.sendJson(res, 404, { error: `No hook configured for session: ${sessionKey}` });
      return;
    }

    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!this.verifyAuth(authHeader, foundToken)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Set up SSE headers with CORS support
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*", // Allow all origins for now
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });

    // Helper to send SSE events
    const sendEvent = (eventType: string, data: unknown) => {
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Process the message with streaming
      await this.processMessageStream(sessionKey, message, (event) => {
        // Map stream events to SSE events
        if (event.type === "token") {
          sendEvent("token", { text: event.text });
        } else if (event.type === "tool_call") {
          sendEvent("tool_call", { id: event.id, name: event.name, input: event.input });
        } else if (event.type === "tool_result") {
          sendEvent("tool_result", { id: event.id, output: event.output });
        } else if (event.type === "done") {
          sendEvent("done", { 
            sessionId: event.sessionId, 
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
            },
            durationMs: event.durationMs,
          });
        } else if (event.type === "error") {
          sendEvent("error", { message: event.message });
        }
      });

      // Close the stream
      res.end();
    } catch (error) {
      // Send error event
      sendEvent("error", { 
        message: error instanceof Error ? error.message : String(error),
      });
      res.end();
    }
  }

  /**
   * Convert a SessionMessage to a Message for Claude API.
   * Returns null for messages that should not be included in the conversation.
   */
  private convertSessionToMessage(sm: SessionMessage): Message | null {
    // Only include user and assistant messages with content
    if ((sm.role === "user" || sm.role === "assistant") && sm.content) {
      return {
        role: sm.role,
        content: sm.content,
      };
    }
    // Skip tool messages - they are internal implementation details
    return null;
  }

  /**
   * Build messages array from session transcript for Claude API.
   * 
   * @param transcript - Full session transcript from session store
   * @param currentMessage - Current user message to append
   * @returns Array of messages for Claude API
   */
  private buildMessagesArray(transcript: SessionMessage[], currentMessage: string): Message[] {
    const messages: Message[] = [];
    
    // Convert existing transcript messages
    for (const sessionMsg of transcript) {
      const message = this.convertSessionToMessage(sessionMsg);
      if (message) {
        messages.push(message);
      }
    }
    
    // Add current user message
    messages.push({
      role: "user",
      content: currentMessage,
    });
    
    return messages;
  }

  /**
   * Process a message through Claude CLI and update session.
   */
  private async processMessage(sessionKey: string, message: string): Promise<string> {
    // Load full transcript from session store (before appending current message)
    const transcript = await this.context.sessionStore.load(sessionKey);
    
    // Build messages array from transcript
    const messages = this.buildMessagesArray(transcript, message);
    
    // Append user message to session transcript (audit log)
    const userMessage: SessionMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await this.context.sessionStore.append(sessionKey, userMessage);

    // Get session metadata
    const metadata = await this.context.sessionStore.getMetadata(sessionKey);

    // Build system prompt for the request
    const systemPrompt = await buildSystemPromptWithEnv(
      this.context.workspaceDir,
      this.env,
      this.context.promptOptions
    );

    // Call Claude CLI with full conversation history
    let claudeResponse;
    try {
      claudeResponse = await callClaude(
        {
          messages: messages,
          systemPrompt: systemPrompt,
        },
        this.context.claudeConfig
      );
    } catch (error) {
      throw error;
    }

    // Extract response text
    const responseText = claudeResponse.result;

    // Append assistant response to session transcript (audit log)
    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: responseText,
      timestamp: Date.now(),
    };
    await this.context.sessionStore.append(sessionKey, assistantMessage);

    // Update session metadata with Claude session ID and token usage
    const updatedMetadata = {
      lastActive: Date.now(),
      claudeSessionId: claudeResponse.sessionId,
      totalInputTokens: (metadata?.totalInputTokens || 0) + claudeResponse.usage.inputTokens,
      totalOutputTokens: (metadata?.totalOutputTokens || 0) + claudeResponse.usage.outputTokens,
      totalCacheReadTokens: (metadata?.totalCacheReadTokens || 0) + claudeResponse.usage.cacheReadTokens,
      messageCount: (metadata?.messageCount || 0) + 1,
    };
    
    await this.context.sessionStore.setMetadata(sessionKey, updatedMetadata);

    // Call onResponse callback if provided
    if (this.context.onResponse) {
      await this.context.onResponse(sessionKey, responseText);
    }

    return responseText;
  }

  /**
   * Process a message through Claude CLI with streaming and update session.
   */
  private async processMessageStream(sessionKey: string, message: string, onEvent: (event: StreamEvent) => void): Promise<void> {
    // Load full transcript from session store (before appending current message)
    const transcript = await this.context.sessionStore.load(sessionKey);
    
    // Build messages array from transcript
    const messages = this.buildMessagesArray(transcript, message);
    
    // Append user message to session transcript (audit log)
    const userMessage: SessionMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await this.context.sessionStore.append(sessionKey, userMessage);

    // Get session metadata
    const metadata = await this.context.sessionStore.getMetadata(sessionKey);

    // Build system prompt for the request
    const systemPrompt = await buildSystemPromptWithEnv(
      this.context.workspaceDir,
      this.env,
      this.context.promptOptions
    );

    // Call Claude CLI with streaming and full conversation history
    let claudeResponse;
    try {
      claudeResponse = await callClaudeStream(
        {
          messages: messages,
          systemPrompt: systemPrompt,
        },
        this.context.claudeConfig,
        onEvent,
        this.env
      );
    } catch (error) {
      throw error;
    }

    // Extract response text
    const responseText = claudeResponse.result;

    // Append assistant response to session transcript (audit log)
    const assistantMessage: SessionMessage = {
      role: "assistant",
      content: responseText,
      timestamp: Date.now(),
    };
    await this.context.sessionStore.append(sessionKey, assistantMessage);

    // Update session metadata with token usage
    const updatedMetadata = {
      lastActive: Date.now(),
      totalInputTokens: (metadata?.totalInputTokens || 0) + claudeResponse.usage.inputTokens,
      totalOutputTokens: (metadata?.totalOutputTokens || 0) + claudeResponse.usage.outputTokens,
      totalCacheReadTokens: (metadata?.totalCacheReadTokens || 0) + claudeResponse.usage.cacheReadTokens,
      messageCount: (metadata?.messageCount || 0) + 1,
    };
    
    await this.context.sessionStore.setMetadata(sessionKey, updatedMetadata);

    // Call onResponse callback if provided
    if (this.context.onResponse) {
      await this.context.onResponse(sessionKey, responseText);
    }
  }

  /**
   * Extract message text from webhook payload.
   */
  private extractMessage(payload: Record<string, unknown>): string {
    // Support common payload formats
    if (typeof payload.message === "string") {
      return payload.message;
    }
    if (typeof payload.text === "string") {
      return payload.text;
    }
    if (typeof payload.content === "string") {
      return payload.content;
    }
    
    // Fallback: stringify the entire payload
    return JSON.stringify(payload);
  }

  /**
   * Verify Bearer token authentication.
   */
  private verifyAuth(authHeader: string | undefined, expectedToken: string): boolean {
    if (!authHeader) {
      return false;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return false;
    }

    const providedToken = match[1];
    return providedToken === expectedToken;
  }

  /**
   * Handle POST /session/reset endpoint.
   */
  private async handleSessionReset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse request body
    const body = await this.parseBody(req);
    
    const sessionKey = body.sessionKey;
    
    if (typeof sessionKey !== "string") {
      this.sendJson(res, 400, { error: "Missing 'sessionKey' in request body" });
      return;
    }

    // For session reset, we need to find a matching hook config to verify auth
    let foundToken: string | null = null;
    for (const hookConfig of Object.values(this.config.hooks)) {
      if (hookConfig.sessionKey === sessionKey) {
        foundToken = hookConfig.token;
        break;
      }
    }

    if (!foundToken) {
      this.sendJson(res, 404, { error: `No hook configured for session: ${sessionKey}` });
      return;
    }

    // Verify authentication
    const authHeader = req.headers.authorization;
    if (!this.verifyAuth(authHeader, foundToken)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    // Perform session reset
    await this.resetSession(sessionKey);

    // Return response
    this.sendJson(res, 200, {
      status: "ok",
      message: "Session reset successfully",
      sessionKey,
    });
  }

  /**
   * Reset a session by clearing its Claude CLI session ID and token counters.
   * This forces the next message to start a new Claude CLI session.
   */
  private async resetSession(sessionKey: string): Promise<void> {
    const metadata = await this.context.sessionStore.getMetadata(sessionKey);
    
    if (metadata) {
      log.info("[gateway]", `Manual session reset requested for ${sessionKey}`);
      
      // Reset token counters
      await this.context.sessionStore.setMetadata(sessionKey, {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        messageCount: 0,
        lastActive: Date.now(),
      });
      
      log.info("[gateway]", `Session ${sessionKey} reset complete`);
    }
  }

  /**
   * Check if session should be reset based on token usage threshold.
   * Returns true if reset is needed.
   */
  private shouldResetSession(metadata: { totalInputTokens?: number; totalOutputTokens?: number; totalCacheReadTokens?: number }): boolean {
    const threshold = this.context.maxContextTokens || 150000;
    const totalTokens = (metadata.totalInputTokens || 0) + (metadata.totalOutputTokens || 0) + (metadata.totalCacheReadTokens || 0);
    return totalTokens >= threshold;
  }

  /**
   * Get the last N messages from session transcript for context carryover.
   */
  private async getCarryoverMessages(sessionKey: string, count: number = 10): Promise<SessionMessage[]> {
    const allMessages = await this.context.sessionStore.load(sessionKey);
    return allMessages.slice(-count);
  }

  /**
   * Format carryover messages into a preamble string.
   */
  private formatCarryoverPreamble(messages: SessionMessage[], userMessage: string): string {
    const conversationLines: string[] = [];
    
    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        conversationLines.push(`User: ${msg.content}`);
      } else if (msg.role === "assistant" && msg.content) {
        conversationLines.push(`Assistant: ${msg.content}`);
      }
      // Skip tool messages as they are internal implementation details
    }

    const preamble = `[Session context carryover — previous conversation summary follows]

The following is recent conversation history being carried over to a new session:

${conversationLines.join("\n\n")}

[End of carryover — new message follows]

${userMessage}`;

    return preamble;
  }

  /**
   * Parse JSON request body.
   */
  private async parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = "";
      
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error("Invalid JSON in request body"));
        }
      });

      req.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Send JSON response.
   */
  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
