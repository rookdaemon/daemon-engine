/**
 * session.ts — Session state management and transcript persistence.
 *
 * Manages conversation sessions with in-memory registry and JSONL persistence.
 * Each session holds messages, metadata (model, channel, timestamps), and a unique
 * session key following the format: agent:{agentId}:{rest}.
 * Transcripts are saved/loaded as JSONL files (one JSON object per line).
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
/** In-memory registry of active sessions */
const sessionRegistry = new Map();
/** Default transcript directory */
export const DEFAULT_TRANSCRIPT_DIR = join(homedir(), ".daemon-engine", "sessions");
/**
 * Validates session key format: agent:{agentId}:{rest}
 *
 * @param key - The session key to validate
 * @returns true if valid, false otherwise
 */
export function validateSessionKey(key) {
    if (!key)
        return false;
    const parts = key.split(":");
    if (parts.length < 3)
        return false;
    if (parts[0] !== "agent")
        return false;
    if (!parts[1])
        return false; // agentId must not be empty
    return true;
}
/**
 * Creates a new session and adds it to the registry.
 *
 * @param sessionKey - Unique session key in format agent:{agentId}:{rest}
 * @param metadata - Session metadata (model and channel)
 * @returns The created session
 * @throws Error if session key format is invalid
 */
export function createSession(sessionKey, metadata) {
    if (!validateSessionKey(sessionKey)) {
        throw new Error(`Invalid session key format. Expected agent:{agentId}:{rest}, got: ${sessionKey}`);
    }
    const now = Date.now();
    const session = {
        sessionKey,
        messages: [],
        metadata: {
            model: metadata.model,
            channel: metadata.channel,
            createdAt: now,
            updatedAt: now,
        },
    };
    sessionRegistry.set(sessionKey, session);
    return session;
}
/**
 * Retrieves a session from the registry.
 *
 * @param sessionKey - The session key to retrieve
 * @returns The session, or undefined if not found
 */
export function getSession(sessionKey) {
    return sessionRegistry.get(sessionKey);
}
/**
 * Lists all active sessions in the registry.
 *
 * @returns Array of all sessions
 */
export function listSessions() {
    return Array.from(sessionRegistry.values());
}
/**
 * Adds a message to a session.
 *
 * @param session - The session to add the message to
 * @param message - The message to add (role and content; timestamp added automatically)
 */
export function addMessage(session, message) {
    const timestampedMessage = {
        role: message.role,
        content: message.content,
        timestamp: Date.now(),
    };
    session.messages.push(timestampedMessage);
    session.metadata.updatedAt = Date.now();
}
/**
 * Persists a session to a JSONL file.
 *
 * @param session - The session to persist
 * @param transcriptDir - Directory to save the transcript (defaults to ~/.daemon-engine/sessions/)
 */
export async function persistSession(session, transcriptDir = DEFAULT_TRANSCRIPT_DIR) {
    // Ensure directory exists
    await mkdir(transcriptDir, { recursive: true });
    // Build JSONL content (one JSON object per line)
    const lines = session.messages.map((msg) => JSON.stringify(msg));
    const content = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    const filepath = join(transcriptDir, `${session.sessionKey}.jsonl`);
    await writeFile(filepath, content, "utf-8");
}
/**
 * Loads a session from a JSONL file.
 *
 * @param sessionKey - The session key to load
 * @param transcriptDir - Directory to load from (defaults to ~/.daemon-engine/sessions/)
 * @param metadata - Session metadata (model and channel)
 * @returns The loaded session, or a new empty session if file doesn't exist
 */
export async function loadSession(sessionKey, transcriptDir = DEFAULT_TRANSCRIPT_DIR, metadata) {
    if (!validateSessionKey(sessionKey)) {
        throw new Error(`Invalid session key format. Expected agent:{agentId}:{rest}, got: ${sessionKey}`);
    }
    const filepath = join(transcriptDir, `${sessionKey}.jsonl`);
    let messages = [];
    try {
        const content = await readFile(filepath, "utf-8");
        const lines = content.trim().split("\n").filter((line) => line);
        messages = lines.map((line) => JSON.parse(line));
    }
    catch (error) {
        // File doesn't exist or is empty — start with empty messages
        if (error.code !== "ENOENT") {
            // Re-throw if it's not a "file not found" error
            throw error;
        }
    }
    // Derive timestamps from messages if available, otherwise use current time
    const now = Date.now();
    const createdAt = messages.length > 0 ? messages[0].timestamp : now;
    const updatedAt = messages.length > 0 ? messages[messages.length - 1].timestamp : now;
    const session = {
        sessionKey,
        messages,
        metadata: {
            model: metadata.model,
            channel: metadata.channel,
            createdAt,
            updatedAt,
        },
    };
    sessionRegistry.set(sessionKey, session);
    return session;
}
/**
 * Clears the session registry.
 * Used primarily for testing.
 */
export function clearRegistry() {
    sessionRegistry.clear();
}
