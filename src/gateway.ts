/**
 * gateway.ts — HTTP gateway server for webhook routing to Claude CLI sessions.
 *
 * Receives webhooks from external services (Agora, Discord, etc.), authenticates
 * them, and routes messages to appropriate Claude CLI sessions via session store.
 */

import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { ClaudeCliConfig, callClaude } from "./providers/claude-cli.js";
import { SessionStore, SessionMessage } from "./session.js";
import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";
import { buildSystemPromptWithEnv, SystemPromptOptions } from "./workspace.js";

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

      // POST /session/reset endpoint
      if (method === "POST" && url === "/session/reset") {
        await this.handleSessionReset(req, res);
        return;
      }

      // 404 for unknown routes
      this.sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("Error handling request:", error);
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
      version: "0.1.0",
    });
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
   * Process a message through Claude CLI and update session.
   */
  private async processMessage(sessionKey: string, message: string): Promise<string> {
    // Append user message to session transcript (audit log)
    const userMessage: SessionMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    await this.context.sessionStore.append(sessionKey, userMessage);

    // Get session metadata to check for existing Claude CLI session
    let metadata = await this.context.sessionStore.getMetadata(sessionKey);
    const existingClaudeSessionId = metadata?.claudeSessionId;

    // Check if we should reset session due to token threshold
    let shouldReset = false;
    let carryoverPreamble: string | null = null;
    
    if (metadata && existingClaudeSessionId && this.shouldResetSession(metadata)) {
      shouldReset = true;
      
      // Get last N messages for carryover
      const carryoverMessages = await this.getCarryoverMessages(sessionKey, 10);
      carryoverPreamble = this.formatCarryoverPreamble(carryoverMessages, message);
      
      console.log(`[gateway] Token threshold reached for session ${sessionKey}. Total tokens: ${(metadata.totalInputTokens || 0) + (metadata.totalOutputTokens || 0) + (metadata.totalCacheReadTokens || 0)}. Resetting with context carryover.`);
      
      // Reset the session (clear Claude session ID)
      await this.resetSession(sessionKey);
      
      // Reload metadata after reset
      metadata = await this.context.sessionStore.getMetadata(sessionKey);
    }

    // Use carryover preamble if we're resetting, otherwise use original message
    const promptToSend = shouldReset && carryoverPreamble ? carryoverPreamble : message;
    const continueSessionId = shouldReset ? undefined : existingClaudeSessionId;

    // Build fresh system prompt for new sessions
    let systemPrompt: string | undefined;
    if (!continueSessionId) {
      systemPrompt = await buildSystemPromptWithEnv(
        this.context.workspaceDir,
        this.env,
        this.context.promptOptions
      );
    }

    // Call Claude CLI with session continuation if available
    let claudeResponse;
    try {
      claudeResponse = await callClaude(
        {
          prompt: promptToSend,
          systemPrompt: systemPrompt || "",
          continueSession: continueSessionId,
        },
        this.context.claudeConfig
      );

      // Check if the call failed due to an invalid session
      if (claudeResponse.type === "error" && continueSessionId) {
        // Check if error is related to invalid/expired session
        // Note: This is a heuristic check based on common error patterns.
        // If Claude CLI provides specific error codes for session errors in the future,
        // this should be updated to use those for more precise detection.
        const errorText = claudeResponse.result.toLowerCase();
        const isSessionError = 
          errorText.includes("session") && (
            errorText.includes("not found") ||
            errorText.includes("expired") ||
            errorText.includes("invalid") ||
            errorText.includes("does not exist")
          );
        
        if (isSessionError) {
          // TODO: Consider using structured logging or metrics to track session reset frequency
          console.error(`Claude CLI session ${continueSessionId} expired or invalid. Starting new session.`);
          
          // Build fresh system prompt for new session
          const retrySystemPrompt = await buildSystemPromptWithEnv(
            this.context.workspaceDir,
            this.env,
            this.context.promptOptions
          );
          
          // Retry with a new session (no continueSession)
          claudeResponse = await callClaude(
            {
              prompt: message,
              systemPrompt: retrySystemPrompt,
            },
            this.context.claudeConfig
          );
        }
      }
    } catch (error) {
      // If session continuation fails, try starting a new session
      if (continueSessionId) {
        // TODO: Consider using structured logging or metrics to track session reset frequency
        console.error(`Failed to continue Claude CLI session ${continueSessionId}. Starting new session.`, error);
        
        // Build fresh system prompt for new session
        const retrySystemPrompt = await buildSystemPromptWithEnv(
          this.context.workspaceDir,
          this.env,
          this.context.promptOptions
        );
        
        claudeResponse = await callClaude(
          {
            prompt: message,
            systemPrompt: retrySystemPrompt,
          },
          this.context.claudeConfig
        );
      } else {
        throw error;
      }
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
      console.log(`[gateway] Manual session reset requested for ${sessionKey}`);
      
      // Clear Claude session ID and reset token counters
      await this.context.sessionStore.setMetadata(sessionKey, {
        claudeSessionId: undefined,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        messageCount: 0,
        lastActive: Date.now(),
      });
      
      console.log(`[gateway] Session ${sessionKey} reset complete`);
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
