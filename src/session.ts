/**
 * session.ts — Session state, transcript persistence (JSONL).
 *
 * This module handles session message storage using JSONL (JSON Lines) format
 * for transcripts and JSON for metadata. Sessions are stored in
 * state/sessions/{sessionKey}/ directories.
 */

import { mkdir, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import { join } from "node:path";

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
  constructor(private readonly baseDir: string = "state/sessions") {}

  /**
   * Get the directory path for a session.
   */
  private getSessionDir(sessionKey: string): string {
    // Sanitize session key for use as directory name
    const safeName = sessionKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
    return join(this.baseDir, safeName);
  }

  /**
   * Get the transcript file path for a session.
   */
  private getTranscriptPath(sessionKey: string): string {
    return join(this.getSessionDir(sessionKey), "transcript.jsonl");
  }

  /**
   * Get the metadata file path for a session.
   */
  private getMetadataPath(sessionKey: string): string {
    return join(this.getSessionDir(sessionKey), "metadata.json");
  }

  /**
   * Ensure the session directory exists.
   */
  private async ensureSessionDir(sessionKey: string): Promise<void> {
    const dir = this.getSessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
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

    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.length > 0);

    return lines.map(line => JSON.parse(line) as SessionMessage);
  }

  /**
   * Append a message to a session transcript.
   */
  async append(sessionKey: string, message: SessionMessage): Promise<void> {
    await this.ensureSessionDir(sessionKey);
    const transcriptPath = this.getTranscriptPath(sessionKey);

    // Append message as a single line
    const line = JSON.stringify(message) + "\n";
    await writeFile(transcriptPath, line, {
      encoding: "utf-8",
      flag: "a", // append mode
    });
  }

  /**
   * Get metadata for a session. Returns null if session doesn't exist.
   */
  async getMetadata(sessionKey: string): Promise<SessionMetadata | null> {
    const metadataPath = this.getMetadataPath(sessionKey);

    if (!(await this.fileExists(metadataPath))) {
      return null;
    }

    const content = await readFile(metadataPath, "utf-8");
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
      const content = await readFile(metadataPath, "utf-8");
      existing = JSON.parse(content) as SessionMetadata;
    }

    // Merge with new metadata
    const updated = { ...existing, ...meta };

    // Write back to file
    await writeFile(metadataPath, JSON.stringify(updated, null, 2), "utf-8");
  }

  /**
   * List all session keys.
   */
  async list(): Promise<string[]> {
    // Ensure base directory exists
    if (!(await this.fileExists(this.baseDir))) {
      return [];
    }

    // Read all directories in the base directory
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    
    // Filter to only directories and return their names
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  }

  /**
   * Clear a session (remove all files).
   */
  async clear(sessionKey: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionKey);
    await rm(sessionDir, { recursive: true, force: true });
  }
}

/**
 * Default session store instance.
 */
export const sessionStore = new FileSessionStore();
