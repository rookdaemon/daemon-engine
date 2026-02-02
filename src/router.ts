/**
 * router.ts — Message routing to sessions.
 *
 * Routes incoming messages to conversation sessions based on channel and sender
 * identity. Creates new sessions on first message from a source, or retrieves
 * existing sessions for returning sources. Supports default agent resolution
 * when only one agent is configured.
 */

import type { Config } from "./config.js";
import { createSession, getSession } from "./session.js";
import type { Session } from "./session.js";

/**
 * Incoming message descriptor for routing.
 */
export interface IncomingMessage {
  /** Agent ID (optional, resolved from config if single agent) */
  agentId?: string;
  /** Channel type (e.g., "webchat", "discord", "telegram") */
  channel: string;
  /** Unique sender/channel identifier */
  channelId: string;
  /** Message content */
  content: string;
  /** Optional model override for this session */
  model?: string;
}

/**
 * Route an incoming message to a session.
 *
 * Determines the target session based on agent ID, channel, and sender identity.
 * If the session doesn't exist, creates a new one. If it exists, retrieves it.
 * Resolves agent ID from config when omitted and only one agent is defined.
 *
 * @param msg - Incoming message descriptor
 * @param config - Configuration with agent definitions
 * @returns The target session for this message
 * @throws Error if agentId is invalid or cannot be resolved
 */
export function routeMessage(msg: IncomingMessage, config: Config): Session {
  // Validate required fields
  if (!msg.channel || !msg.channelId) {
    throw new Error("Message must include channel and channelId");
  }

  // Resolve agent ID
  let agentId: string = msg.agentId ?? "";

  if (!agentId) {
    // Attempt to use default agent if only one is configured
    const agentCount = config.agents.size;

    if (agentCount === 0) {
      throw new Error("No agents configured");
    }

    if (agentCount === 1) {
      // Use the single agent as default
      agentId = config.agents.keys().next().value as string;
    } else {
      // Multiple agents — agentId is required
      throw new Error(
        "agentId is required when multiple agents are configured",
      );
    }
  }

  // Validate agent exists
  if (!config.agents.has(agentId)) {
    throw new Error(`Agent '${agentId}' not found in config`);
  }

  // Construct session key
  const sessionKey = `agent:${agentId}:${msg.channel}:${msg.channelId}`;

  // Try to retrieve existing session
  let session = getSession(sessionKey);

  if (!session) {
    // Create new session
    session = createSession(agentId, msg.channel, msg.channelId, msg.model);
  }

  return session;
}
