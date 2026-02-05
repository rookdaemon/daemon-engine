/**
 * config.ts — Load and validate config from ~/.daemon-engine/config.yaml (or JSON).
 *
 * This module loads the daemon engine configuration file, validates its structure,
 * and interpolates environment variables. It fails fast with clear error messages
 * if the config is invalid or missing required fields.
 */

import * as yaml from "js-yaml";
import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";

/**
 * Configuration for the LLM model.
 */
export interface ModelConfig {
  /** LLM provider: "anthropic" or "openai" */
  provider: "anthropic" | "openai";
  /** Model name (e.g., "claude-sonnet-4-20250514", "gpt-4") */
  name: string;
  /** API key for the model provider */
  apiKey: string;
}

/**
 * Configuration for the HTTP server.
 */
export interface ServerConfig {
  /** Port number for the HTTP server */
  port: number;
}

/**
 * Configuration for observability endpoints.
 */
export interface ObservabilityConfig {
  /** Bearer token for authentication */
  token: string;
}

/**
 * Complete daemon engine configuration.
 */
export interface Config {
  /** Model configuration */
  model: ModelConfig;
  /** Path to the workspace directory */
  workspace: string;
  /** Server configuration */
  server: ServerConfig;
  /** Optional observability configuration */
  observability?: ObservabilityConfig;
}

/**
 * Load and validate configuration from a file.
 *
 * Reads a YAML or JSON config file, interpolates environment variables,
 * validates the structure, and returns a typed config object.
 *
 * Environment variables are interpolated using the syntax: ${ENV_VAR}
 *
 * @param configPath - Absolute path to the config file (.yaml or .json)
 * @returns Validated config object
 * @throws Error if the file doesn't exist, has invalid syntax, or is missing required fields
 */
export async function loadConfig(
  configPath: string,
  env: Environment = createNodeEnvironment()
): Promise<Config> {
  // Read the config file
  let content: string;
  try {
    content = await env.fs.readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw error;
  }

  // Interpolate environment variables
  content = interpolateEnvVars(content, env);

  // Parse the file (YAML or JSON)
  let parsed: unknown;
  try {
    if (configPath.endsWith(".json")) {
      parsed = JSON.parse(content);
    } else {
      // YAML parser also handles JSON, but we use JSON.parse for .json files
      parsed = yaml.load(content);
    }
  } catch (error) {
    throw new Error(
      `Failed to parse config file: ${(error as Error).message}`
    );
  }

  // Validate and return
  return validateConfig(parsed);
}

/**
 * Interpolate environment variables in a string.
 *
 * Replaces ${ENV_VAR} with the value of process.env.ENV_VAR.
 * Throws an error if an environment variable is referenced but not set.
 *
 * @param content - String with potential ${ENV_VAR} references
 * @returns String with environment variables interpolated
 * @throws Error if a referenced environment variable is not set
 */
function interpolateEnvVars(content: string, env: Environment): string {
  return content.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, varName) => {
    const value = env.process.env(varName);
    if (value === undefined) {
      throw new Error(`Environment variable not set: ${varName}`);
    }
    return value;
  });
}

/**
 * Validate that the parsed config has the required structure.
 *
 * @param parsed - Parsed config object
 * @returns Validated config object
 * @throws Error if the config is missing required fields or has invalid values
 */
function validateConfig(parsed: unknown): Config {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid config: config must be an object");
  }

  const config = parsed as Record<string, unknown>;

  // Validate model
  if (typeof config.model !== "object" || config.model === null) {
    throw new Error("Invalid config: model is required");
  }

  const model = config.model as Record<string, unknown>;

  if (typeof model.provider !== "string") {
    throw new Error("Invalid config: model.provider is required");
  }

  if (model.provider !== "anthropic" && model.provider !== "openai") {
    throw new Error(
      'Invalid config: model.provider must be "anthropic" or "openai"'
    );
  }

  if (typeof model.name !== "string") {
    throw new Error("Invalid config: model.name is required");
  }

  if (typeof model.apiKey !== "string") {
    throw new Error("Invalid config: model.apiKey is required");
  }

  // Validate workspace
  if (typeof config.workspace !== "string") {
    throw new Error("Invalid config: workspace is required");
  }

  // Validate server
  if (typeof config.server !== "object" || config.server === null) {
    throw new Error("Invalid config: server is required");
  }

  const server = config.server as Record<string, unknown>;

  if (server.port === undefined) {
    throw new Error("Invalid config: server.port is required");
  }

  if (typeof server.port !== "number") {
    throw new Error("Invalid config: server.port must be a number");
  }

  // Validate observability (optional)
  let observability: ObservabilityConfig | undefined;
  if (config.observability !== undefined) {
    if (typeof config.observability !== "object" || config.observability === null) {
      throw new Error("Invalid config: observability must be an object");
    }

    const obs = config.observability as Record<string, unknown>;

    if (typeof obs.token !== "string") {
      throw new Error("Invalid config: observability.token is required");
    }

    observability = {
      token: obs.token,
    };
  }

  // Return validated config
  return {
    model: {
      provider: model.provider as "anthropic" | "openai",
      name: model.name,
      apiKey: model.apiKey,
    },
    workspace: config.workspace,
    server: {
      port: server.port,
    },
    observability,
  };
}
