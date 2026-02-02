/**
 * session.ts — Session state management and transcript persistence.
 *
 * Manages conversation sessions with in-memory registry and JSONL persistence.
 * Each session holds messages, metadata (model, channel, timestamps), and a unique
 * session key following the format: agent:{agentId}:{rest}.
 * Transcripts are saved/loaded as JSONL files (one JSON object per line).
 */
/** Message role types */
export type MessageRole = "user" | "assistant" | "system";
/** A single message in a conversation */
export interface Message {
    role: MessageRole;
    content: string;
    timestamp: number;
}
/** Session metadata */
export interface SessionMetadata {
    model: string;
    channel: string;
    createdAt: number;
    updatedAt: number;
}
/** A conversation session */
export interface Session {
    sessionKey: string;
    messages: Message[];
    metadata: SessionMetadata;
}
/** Default transcript directory */
export declare const DEFAULT_TRANSCRIPT_DIR: string;
/**
 * Validates session key format: agent:{agentId}:{rest}
 *
 * @param key - The session key to validate
 * @returns true if valid, false otherwise
 */
export declare function validateSessionKey(key: string): boolean;
/**
 * Creates a new session and adds it to the registry.
 *
 * @param sessionKey - Unique session key in format agent:{agentId}:{rest}
 * @param metadata - Session metadata (model and channel)
 * @returns The created session
 * @throws Error if session key format is invalid
 */
export declare function createSession(sessionKey: string, metadata: {
    model: string;
    channel: string;
}): Session;
/**
 * Retrieves a session from the registry.
 *
 * @param sessionKey - The session key to retrieve
 * @returns The session, or undefined if not found
 */
export declare function getSession(sessionKey: string): Session | undefined;
/**
 * Lists all active sessions in the registry.
 *
 * @returns Array of all sessions
 */
export declare function listSessions(): Session[];
/**
 * Adds a message to a session.
 *
 * @param session - The session to add the message to
 * @param message - The message to add (role and content; timestamp added automatically)
 */
export declare function addMessage(session: Session, message: {
    role: MessageRole;
    content: string;
}): void;
/**
 * Persists a session to a JSONL file.
 *
 * @param session - The session to persist
 * @param transcriptDir - Directory to save the transcript (defaults to ~/.daemon-engine/sessions/)
 */
export declare function persistSession(session: Session, transcriptDir?: string): Promise<void>;
/**
 * Loads a session from a JSONL file.
 *
 * @param sessionKey - The session key to load
 * @param transcriptDir - Directory to load from (defaults to ~/.daemon-engine/sessions/)
 * @param metadata - Session metadata (model and channel)
 * @returns The loaded session, or a new empty session if file doesn't exist
 */
export declare function loadSession(sessionKey: string, transcriptDir: string | undefined, metadata: {
    model: string;
    channel: string;
}): Promise<Session>;
/**
 * Clears the session registry.
 * Used primarily for testing.
 */
export declare function clearRegistry(): void;
