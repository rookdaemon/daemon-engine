/**
 * session.ts — Session state and transcript persistence.
 *
 * Manages conversation sessions, keyed by agent + channel + sender identity.
 * Sessions persist message history as JSONL transcripts.
 * (Full implementation will be in a separate task)
 */

/**
 * A conversation session.
 */
export interface Session {
  /** Session key (e.g., "agent:myagent:webchat:user123") */
  key: string;
  /** Agent ID for this session */
  agentId: string;
  /** Channel type (e.g., "webchat", "discord") */
  channel: string;
  /** Channel-specific sender/user identifier */
  channelId: string;
  /** Model override for this session (optional) */
  model?: string;
  /** Message history (simplified for now) */
  messages: Array<{ role: string; content: string }>;
}

/** In-memory session store (temporary implementation) */
const sessions = new Map<string, Session>();

/**
 * Create a new session.
 *
 * @param agentId - Agent identifier
 * @param channel - Channel type
 * @param channelId - Channel-specific sender identifier
 * @param model - Optional model override
 * @returns The newly created session
 */
export function createSession(
  agentId: string,
  channel: string,
  channelId: string,
  model?: string,
): Session {
  const key = `agent:${agentId}:${channel}:${channelId}`;
  const session: Session = {
    key,
    agentId,
    channel,
    channelId,
    model,
    messages: [],
  };
  sessions.set(key, session);
  return session;
}

/**
 * Retrieve an existing session by key.
 *
 * @param key - Session key
 * @returns The session, or undefined if not found
 */
export function getSession(key: string): Session | undefined {
  return sessions.get(key);
}

/**
 * Clear all sessions (for testing).
 */
export function clearSessions(): void {
  sessions.clear();
}
