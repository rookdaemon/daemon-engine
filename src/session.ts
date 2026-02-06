/**
 * session.ts — Session state, transcript persistence (JSONL).
 *
 * This module handles session message storage using JSONL (JSON Lines) format
 * for transcripts and JSON for metadata. Sessions are stored in
 * state/sessions/{sessionKey}/ directories.
 */

import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";
import type { Dirent } from "node:fs";

/**
 * A tool call made by the assistant.
 */
export interface ToolCall {
  /** Unique identifier for this tool call. */
  id: string;
  /** Name of the tool being called. */
  name: string;
  /** Input parameters for the tool. */
  input: Record<string, unknown>;
}

/**
 * A message in a session transcript.
 *
 * Messages can be from the user, assistant, or tool results.
 */
export interface SessionMessage {
  /** Role of the message sender. */
  role: "user" | "assistant" | "tool";
  /** Text content of the message (null for assistant messages with only tool calls). */
  content: string | null;
  /** Tool calls made by the assistant (only for assistant role). */
  toolCalls?: ToolCall[];
  /** ID of the tool call this result is for (only for tool role). */
  toolCallId?: string;
  /** Unix timestamp in milliseconds when this message was created. */
  timestamp: number;
}

/**
 * Metadata about a session.
 */
export interface SessionMetadata {
  /** Unique identifier for this session (e.g., "agent:main:webchat"). */
  sessionKey: string;
  /** LLM model used for this session. */
  model: string;
  /** Unix timestamp in milliseconds when the session was created. */
  created: number;
  /** Unix timestamp in milliseconds when the session was last active. */
  lastActive: number;
  /** Number of times the session transcript has been compacted. */
  compactionCount: number;
  /** Total input tokens consumed across all messages in this session. */
  totalInputTokens?: number;
  /** Total output tokens consumed across all messages in this session. */
  totalOutputTokens?: number;
  /** Total cache read tokens consumed across all messages in this session. */
  totalCacheReadTokens?: number;
  /** Total number of messages in this session. */
  messageCount?: number;
  /** Unix timestamp in milliseconds when the last compaction occurred. */
  lastCompactionTimestamp?: number;
  /** The summary generated during the last compaction (for iterative compaction). */
  lastSummary?: string;
}

/**
 * Interface for session storage operations.
 */
export interface SessionStore {
  /** Load all messages from a session transcript. */
  load(sessionKey: string): Promise<SessionMessage[]>;
  /** Append a message to a session transcript. */
  append(sessionKey: string, message: SessionMessage): Promise<void>;
  /** Get metadata for a session. Returns null if session doesn't exist. */
  getMetadata(sessionKey: string): Promise<SessionMetadata | null>;
  /** Set or update metadata for a session. */
  setMetadata(sessionKey: string, meta: Partial<SessionMetadata>): Promise<void>;
  /** List all session keys. */
  list(): Promise<string[]>;
  /** Clear a session (remove all files). */
  clear(sessionKey: string): Promise<void>;
}

/**
 * File-system based session store implementation.
 */
export class FileSessionStore implements SessionStore {
  /**
   * Create a new FileSessionStore.
   * @param baseDir - Base directory for session storage (defaults to "state/sessions").
   */
  constructor(
    private readonly baseDir: string = "state/sessions",
    private readonly env: Environment = createNodeEnvironment()
  ) {}

  /**
   * Get the directory path for a session.
   */
  private getSessionDir(sessionKey: string): string {
    const safeName = this.env.path.safeId(sessionKey);
    return this.env.path.join(this.baseDir, safeName);
  }

  /**
   * Get the transcript file path for a session.
   */
  private getTranscriptPath(sessionKey: string): string {
    return this.env.path.join(this.getSessionDir(sessionKey), "transcript.jsonl");
  }

  /**
   * Get the metadata file path for a session.
   */
  private getMetadataPath(sessionKey: string): string {
    return this.env.path.join(this.getSessionDir(sessionKey), "metadata.json");
  }

  /**
   * Ensure the session directory exists.
   */
  private async ensureSessionDir(sessionKey: string): Promise<void> {
    const dir = this.getSessionDir(sessionKey);
    await this.env.fs.mkdir(dir, { recursive: true });
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await this.env.fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load all messages from a session transcript.
   */
  async load(sessionKey: string): Promise<SessionMessage[]> {
    const transcriptPath = this.getTranscriptPath(sessionKey);

    // If transcript doesn't exist, return empty array
    if (!(await this.fileExists(transcriptPath))) {
      return [];
    }

    const content = await this.env.fs.readFile(transcriptPath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.length > 0);

    return lines.map(line => JSON.parse(line) as SessionMessage);
  }

  /**
   * Append a message to a session transcript.
   * 
   * Ensures metadata exists with the sessionKey set.
   */
  async append(sessionKey: string, message: SessionMessage): Promise<void> {
    await this.ensureSessionDir(sessionKey);
    const transcriptPath = this.getTranscriptPath(sessionKey);

    // Ensure metadata exists with at least the sessionKey
    const metadataPath = this.getMetadataPath(sessionKey);
    if (!(await this.fileExists(metadataPath))) {
      await this.env.fs.writeFile(metadataPath, JSON.stringify({ sessionKey }, null, 2), "utf-8");
    }

    // Append message as a single line
    const line = JSON.stringify(message) + "\n";
    await this.env.fs.writeFileAppend(transcriptPath, line, "utf-8");
  }

  /**
   * Get metadata for a session. Returns null if session doesn't exist.
   */
  async getMetadata(sessionKey: string): Promise<SessionMetadata | null> {
    const metadataPath = this.getMetadataPath(sessionKey);

    if (!(await this.fileExists(metadataPath))) {
      return null;
    }

    const content = await this.env.fs.readFile(metadataPath, "utf-8");
    return JSON.parse(content) as SessionMetadata;
  }

  /**
   * Set or update metadata for a session.
   */
  async setMetadata(sessionKey: string, meta: Partial<SessionMetadata>): Promise<void> {
    await this.ensureSessionDir(sessionKey);
    const metadataPath = this.getMetadataPath(sessionKey);

    // Load existing metadata if it exists
    let existing: Partial<SessionMetadata> = {};
    if (await this.fileExists(metadataPath)) {
      const content = await this.env.fs.readFile(metadataPath, "utf-8");
      existing = JSON.parse(content) as SessionMetadata;
    }

    // Merge with new metadata, ensuring sessionKey is always set
    const updated = { sessionKey, ...existing, ...meta };

    // Write back to file
    await this.env.fs.writeFile(metadataPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  /**
   * List all session keys.
   * 
   * Returns the original session keys by reading them from metadata.json.
   * Falls back to directory name if metadata doesn't exist.
   */
  async list(): Promise<string[]> {
    // Ensure base directory exists
    if (!(await this.fileExists(this.baseDir))) {
      return [];
    }

    // Read all directories in the base directory
    const entries = await this.env.fs.readdir(this.baseDir, { withFileTypes: true });
    const dirents: Dirent[] = Array.isArray(entries) && entries.length > 0 && typeof entries[0] === "string"
      ? []
      : (entries as Dirent[]);
    const directories = dirents.filter((entry) => entry.isDirectory());
    
    // Read session keys from metadata files
    const sessionKeys: string[] = [];
    for (const dir of directories) {
      const metadataPath = this.env.path.join(this.baseDir, dir.name, "metadata.json");
      
      if (await this.fileExists(metadataPath)) {
        try {
          const content = await this.env.fs.readFile(metadataPath, "utf-8");
          const metadata = JSON.parse(content) as SessionMetadata;
          sessionKeys.push(metadata.sessionKey);
        } catch {
          // If metadata can't be read, fall back to directory name
          sessionKeys.push(dir.name);
        }
      } else {
        // No metadata file, use directory name
        sessionKeys.push(dir.name);
      }
    }
    
    return sessionKeys;
  }

  /**
   * Clear a session (remove all files).
   */
  async clear(sessionKey: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionKey);
    await this.env.fs.rm(sessionDir, { recursive: true, force: true });
  }
}

/**
 * Default session store instance.
 */
export const sessionStore = new FileSessionStore();
