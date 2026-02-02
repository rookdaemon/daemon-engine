/**
 * config.ts — Load and validate configuration from ~/.daemon-engine/
 *
 * Configuration is stored in YAML format and defines agents, providers,
 * channels, and runtime settings.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Agent configuration. */
export interface AgentConfig {
  /** Unique agent identifier. */
  id: string;
  /** Absolute path to workspace directory. */
  workspace: string;
  /** LLM model identifier. */
  model: string;
  /** List of enabled tool names. */
  tools?: string[];
}

/** Heartbeat configuration. */
export interface HeartbeatConfig {
  /** Whether heartbeat is enabled. */
  enabled: boolean;
  /** Heartbeat interval in seconds. */
  intervalSeconds: number;
}

/** Runtime configuration. */
export interface Config {
  /** List of agent configurations. */
  agents: AgentConfig[];
  /** HTTP server port. */
  port: number;
  /** Anthropic API key (optional, can use env var). */
  apiKey?: string;
  /** Heartbeat configuration. */
  heartbeat?: HeartbeatConfig;
}

/**
 * Load configuration from a directory.
 *
 * Reads config.yaml from the given directory and parses it.
 * Uses defaults for missing optional fields.
 *
 * @param configDir - Absolute path to config directory.
 * @returns Parsed configuration.
 */
export async function loadConfig(configDir: string): Promise<Config> {
  const configPath = join(configDir, "config.yaml");
  const content = await readFile(configPath, "utf-8");

  // Simple YAML parsing - just handle the minimal structure needed
  const config = parseYaml(content);

  return {
    agents: (config.agents as AgentConfig[]) || [],
    port: (config.port as number | undefined) ?? 3000,
    apiKey: config.apiKey as string | undefined,
    heartbeat: config.heartbeat as HeartbeatConfig | undefined,
  };
}

/**
 * Minimal YAML parser for config files.
 * Only handles the simple structures we need - not a full YAML parser.
 */
function parseYaml(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentObject: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const leadingSpaces = line.length - line.trimLeft().length;

    // Top-level key
    if (leadingSpaces === 0 && trimmed.includes(":")) {
      const [key, value] = trimmed.split(":", 2);
      currentKey = key.trim();

      if (value && value.trim()) {
        // Inline value
        result[currentKey] = parseValue(value.trim());
        currentKey = null;
        currentArray = null;
        currentObject = null;
      } else if (currentKey === "agents") {
        currentArray = [];
        result.agents = currentArray;
        currentObject = null;
      } else if (currentKey === "heartbeat") {
        currentObject = {};
        result.heartbeat = currentObject;
        currentArray = null;
      }
    }
    // Array item (can have inline property like "- id: value")
    else if (trimmed.startsWith("-")) {
      if (currentArray) {
        currentObject = {};
        currentArray.push(currentObject);

        // Check for inline property after the dash
        const afterDash = trimmed.substring(1).trim();
        if (afterDash.includes(":")) {
          const [key, value] = afterDash.split(":", 2);
          const propKey = key.trim();
          const propValue = value && value.trim() ? parseValue(value.trim()) : [];
          currentObject[propKey] = propValue;
        }
      }
    }
    // Object property (indented)
    else if (leadingSpaces > 0 && trimmed.includes(":")) {
      const [key, value] = trimmed.split(":", 2);
      const propKey = key.trim();
      const propValue = value && value.trim() ? parseValue(value.trim()) : [];

      if (currentObject) {
        currentObject[propKey] = propValue;
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  if (value === "[]") return [];
  return value;
}
