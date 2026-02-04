/**
 * main.ts — Main entry point that wires all daemon components together.
 *
 * This module initializes the workspace, session store, heartbeat runner,
 * and HTTP gateway, then starts the daemon and handles graceful shutdown.
 */

import * as yaml from "js-yaml";
import { Gateway, GatewayConfig, GatewayContext, HookConfig } from "./gateway.js";
import { HeartbeatRunner, HeartbeatConfig, HeartbeatContext, DEFAULT_HEARTBEAT_PROMPT } from "./heartbeat.js";
import { FileSessionStore } from "./session.js";
import { ClaudeCliConfig } from "./providers/claude-cli.js";
import { buildSystemPromptWithEnv } from "./workspace.js";
import type { Environment } from "./env/environment.js";
import { createNodeEnvironment } from "./env/environment.js";

/**
 * Configuration for the daemon.
 */
export interface DaemonConfig {
  /** Path to workspace directory */
  workspace: string;

  /** Timezone for date/time injection (defaults to "UTC") */
  timezone?: string;

  /** Maximum characters per workspace file (defaults to 20000) */
  workspace_max_file_chars?: number;

  /** Claude CLI configuration */
  claude: {
    /** Model name: "opus", "sonnet", or full model identifier */
    model?: string;
    /** Skip permission prompts */
    skipPermissions?: boolean;
    /** Timeout in milliseconds */
    timeout?: number;
  };

  /** Heartbeat configuration */
  heartbeat: {
    /** Whether heartbeat is enabled */
    enabled: boolean;
    /** Interval between heartbeats in milliseconds */
    intervalMs: number;
    /** Prompt to send on each heartbeat */
    prompt?: string;
    /** Optional active hours window [startHour, endHour] in UTC (0-23) */
    activeHours?: [number, number];
  };

  /** Gateway configuration */
  gateway: {
    /** Port to listen on */
    port: number;
    /** Host to bind to (optional, defaults to "0.0.0.0") */
    host?: string;
    /** Hook configurations */
    hooks: Record<string, { token: string; sessionKey: string }>;
  };

  /** Session storage configuration */
  sessions: {
    /** Directory to store session data */
    storeDir: string;
    /** Maximum context tokens before triggering session reset (default: 150000) */
    maxContextTokens?: number;
  };
}

/**
 * Default daemon configuration.
 * Used when no config file is found or to fill in missing fields.
 */
const DEFAULT_CONFIG: DaemonConfig = {
  workspace: "~/.openclaw/workspace",
  timezone: "UTC",
  claude: {
    model: undefined,        // use claude CLI default
    skipPermissions: true,
    timeout: 300000,         // 5 minutes
  },
  heartbeat: {
    enabled: true,
    intervalMs: 120000,      // 2 minutes
    prompt: DEFAULT_HEARTBEAT_PROMPT,
  },
  gateway: {
    port: 8080,
    hooks: {},
  },
  sessions: {
    storeDir: "~/.openclaw/daemon-sessions",
  },
};

// Global state for daemon components
let gateway: Gateway | null = null;
let heartbeatRunner: HeartbeatRunner | null = null;
let sessionStore: FileSessionStore | null = null;
let isShuttingDown = false;
let daemonEnv: Environment = createNodeEnvironment();

/**
 * Load daemon configuration from a file.
 *
 * @param configPath - Path to config file (YAML or JSON)
 * @returns Validated daemon configuration
 */
async function loadDaemonConfig(
  configPath: string,
  env: Environment
): Promise<DaemonConfig> {
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
      parsed = yaml.load(content);
    }
  } catch (error) {
    throw new Error(
      `Failed to parse config file: ${(error as Error).message}`
    );
  }

  // Validate and return
  return validateDaemonConfig(parsed);
}

/**
 * Interpolate environment variables in a string.
 *
 * Replaces ${ENV_VAR} with the value of process.env.ENV_VAR.
 * Throws an error if an environment variable is referenced but not set.
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
 * Validate daemon configuration structure and merge with defaults.
 */
function validateDaemonConfig(parsed: unknown): DaemonConfig {
  // If parsed is null/undefined/not an object, use empty object (will get all defaults)
  const config = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};

  // Extract and validate workspace (use default if not provided)
  const workspace = typeof config.workspace === "string" ? config.workspace : DEFAULT_CONFIG.workspace;

  // Extract and validate timezone
  const timezone = typeof config.timezone === "string" ? config.timezone : DEFAULT_CONFIG.timezone;

  // Extract and validate workspace_max_file_chars
  const workspace_max_file_chars = typeof config.workspace_max_file_chars === "number" 
    ? config.workspace_max_file_chars 
    : undefined;

  // Extract and validate claude config
  const claudeInput = (typeof config.claude === "object" && config.claude !== null) 
    ? config.claude as Record<string, unknown> 
    : {};
  const claude = {
    model: typeof claudeInput.model === "string" ? claudeInput.model : DEFAULT_CONFIG.claude.model,
    skipPermissions: typeof claudeInput.skipPermissions === "boolean" 
      ? claudeInput.skipPermissions 
      : DEFAULT_CONFIG.claude.skipPermissions,
    timeout: typeof claudeInput.timeout === "number" ? claudeInput.timeout : DEFAULT_CONFIG.claude.timeout,
  };

  // Extract and validate heartbeat config
  const heartbeatInput = (typeof config.heartbeat === "object" && config.heartbeat !== null)
    ? config.heartbeat as Record<string, unknown>
    : {};
  
  // Validate heartbeat.enabled if provided
  if (heartbeatInput.enabled !== undefined && typeof heartbeatInput.enabled !== "boolean") {
    throw new Error("Invalid config: heartbeat.enabled must be a boolean");
  }
  
  // Validate heartbeat.intervalMs if provided
  if (heartbeatInput.intervalMs !== undefined && typeof heartbeatInput.intervalMs !== "number") {
    throw new Error("Invalid config: heartbeat.intervalMs must be a number");
  }

  const heartbeat = {
    enabled: typeof heartbeatInput.enabled === "boolean" 
      ? heartbeatInput.enabled 
      : DEFAULT_CONFIG.heartbeat.enabled,
    intervalMs: typeof heartbeatInput.intervalMs === "number" 
      ? heartbeatInput.intervalMs 
      : DEFAULT_CONFIG.heartbeat.intervalMs,
    prompt: typeof heartbeatInput.prompt === "string" ? heartbeatInput.prompt : DEFAULT_CONFIG.heartbeat.prompt,
    activeHours: Array.isArray(heartbeatInput.activeHours) &&
      heartbeatInput.activeHours.length === 2 &&
      typeof heartbeatInput.activeHours[0] === "number" &&
      typeof heartbeatInput.activeHours[1] === "number"
      ? [heartbeatInput.activeHours[0], heartbeatInput.activeHours[1]] as [number, number]
      : undefined,
  };

  // Extract and validate gateway config
  const gatewayInput = (typeof config.gateway === "object" && config.gateway !== null)
    ? config.gateway as Record<string, unknown>
    : {};
  
  // Validate gateway.port if provided
  if (gatewayInput.port !== undefined && typeof gatewayInput.port !== "number") {
    throw new Error("Invalid config: gateway.port must be a number");
  }
  
  // Validate gateway.hooks if provided
  const hooks = (typeof gatewayInput.hooks === "object" && gatewayInput.hooks !== null)
    ? gatewayInput.hooks as Record<string, { token: string; sessionKey: string }>
    : DEFAULT_CONFIG.gateway.hooks;

  const gateway = {
    port: typeof gatewayInput.port === "number" ? gatewayInput.port : DEFAULT_CONFIG.gateway.port,
    host: typeof gatewayInput.host === "string" ? gatewayInput.host : undefined,
    hooks,
  };

  // Extract and validate sessions config
  const sessionsInput = (typeof config.sessions === "object" && config.sessions !== null)
    ? config.sessions as Record<string, unknown>
    : {};
  
  const sessions = {
    storeDir: typeof sessionsInput.storeDir === "string" 
      ? sessionsInput.storeDir 
      : DEFAULT_CONFIG.sessions.storeDir,
    maxContextTokens: typeof sessionsInput.maxContextTokens === "number" 
      ? sessionsInput.maxContextTokens 
      : undefined,
  };

  // Build validated config object
  return {
    workspace,
    timezone,
    workspace_max_file_chars,
    claude,
    heartbeat,
    gateway,
    sessions,
  };
}

/**
 * Find the daemon config file in default locations.
 *
 * Checks (in order):
 * 1. ./daemon.yaml
 * 2. ./daemon.json
 * 3. ~/.config/daemon-engine/daemon.yaml
 * 4. ~/.config/daemon-engine/daemon.json
 *
 * @returns Path to config file or null if not found
 */
async function findDefaultConfig(env: Environment): Promise<string | null> {
  const locations = [
    env.path.resolve("daemon.yaml"),
    env.path.resolve("daemon.json"),
    env.path.join(env.os.homedir(), ".config", "daemon-engine", "daemon.yaml"),
    env.path.join(env.os.homedir(), ".config", "daemon-engine", "daemon.json"),
  ];

  for (const location of locations) {
    try {
      await env.fs.access(location);
      return location;
    } catch {
      // File doesn't exist, try next location
    }
  }

  return null;
}

/**
 * Resolve workspace path (expand tilde).
 */
function resolveWorkspacePath(workspace: string, env: Environment): string {
  if (workspace.startsWith("~/")) {
    return env.path.join(env.os.homedir(), workspace.slice(2));
  }
  return env.path.resolve(workspace);
}

/**
 * Start the daemon with the specified configuration.
 *
 * @param configPath - Optional path to config file. If not provided, searches default locations.
 */
export async function startDaemon(
  configPath?: string,
  env: Environment = createNodeEnvironment()
): Promise<void> {
  if (gateway !== null || heartbeatRunner !== null) {
    throw new Error("Daemon is already running");
  }

  daemonEnv = env;

  // Load config
  let config: DaemonConfig;
  let effectiveConfigPath: string | null = configPath || null;
  
  if (!effectiveConfigPath) {
    effectiveConfigPath = await findDefaultConfig(env);
  }

  if (effectiveConfigPath) {
    config = await loadDaemonConfig(effectiveConfigPath, env);
    console.log(`[daemon-engine] Config: ${effectiveConfigPath}`);
  } else {
    console.log("[daemon-engine] No config file found, using defaults");
    console.log("[daemon-engine] Workspace: ~/.openclaw/workspace/");
    config = DEFAULT_CONFIG;
  }

  // Resolve workspace path
  const workspaceDir = resolveWorkspacePath(config.workspace, env);

  // Verify workspace exists
  try {
    await env.fs.access(workspaceDir);
  } catch {
    throw new Error(
      `Workspace directory not found: ${workspaceDir}\n` +
      `Create it or specify a different path in your config file.`
    );
  }

  // Resolve and create sessions directory
  const sessionsDir = resolveWorkspacePath(config.sessions.storeDir, env);
  await env.fs.mkdir(sessionsDir, { recursive: true });

  // Collect runtime info
  const hostname = env.os.hostname();
  const osName = env.process.platform();
  const arch = env.os.arch();

  // Load workspace context with runtime info
  const systemPrompt = await buildSystemPromptWithEnv(workspaceDir, env, {
    maxFileChars: config.workspace_max_file_chars,
    timezone: config.timezone,
    model: config.claude.model,
    hostname,
    os: osName,
    arch,
    heartbeatPrompt: config.heartbeat.prompt,
  });

  // Initialize session store
  sessionStore = new FileSessionStore(config.sessions.storeDir, env);

  // Create Claude CLI config
  const claudeConfig: ClaudeCliConfig = {
    model: config.claude.model,
    skipPermissions: config.claude.skipPermissions,
    timeout: config.claude.timeout,
    workingDir: workspaceDir,
  };

  // Create gateway context
  const gatewayContext: GatewayContext = {
    workspaceDir,
    claudeConfig,
    sessionStore,
    maxContextTokens: config.sessions.maxContextTokens,
  };

  // Create gateway config
  const gatewayConfig: GatewayConfig = {
    port: config.gateway.port,
    host: config.gateway.host,
    hooks: config.gateway.hooks as Record<string, HookConfig>,
    systemPrompt,
  };

  // Create and start gateway
  gateway = new Gateway(gatewayConfig, gatewayContext, env);
  await gateway.start();

  const actualPort = gateway.getPort();

  console.log(`[daemon-engine] Gateway started on port ${actualPort}`);

  // Create and start heartbeat runner (if enabled)
  if (config.heartbeat.enabled) {
    const heartbeatConfig: HeartbeatConfig = {
      enabled: config.heartbeat.enabled,
      intervalMs: config.heartbeat.intervalMs,
      prompt: config.heartbeat.prompt || DEFAULT_HEARTBEAT_PROMPT,
      activeHours: config.heartbeat.activeHours,
    };

    const heartbeatContext: HeartbeatContext = {
      workspaceDir,
      claudeConfig,
      onResponse: (response, isHeartbeatOk) => {
        if (isHeartbeatOk) {
          console.log("[daemon-engine] Heartbeat: OK");
        } else {
          console.log(`[daemon-engine] Heartbeat response: ${response.substring(0, 100)}...`);
        }
      },
    };

    heartbeatRunner = new HeartbeatRunner(heartbeatConfig, heartbeatContext);
    heartbeatRunner.start();

    console.log(
      `[daemon-engine] Heartbeat enabled (interval: ${config.heartbeat.intervalMs}ms)`
    );
  }

  // Set up signal handlers for graceful shutdown
  env.process.on("SIGTERM", handleShutdown);
  env.process.on("SIGINT", handleShutdown);

  console.log(`[daemon-engine] Daemon started successfully`);
  console.log(`[daemon-engine] Workspace: ${workspaceDir}`);
  console.log(`[daemon-engine] Sessions: ${config.sessions.storeDir}`);
}

/**
 * Stop the daemon and clean up resources.
 */
export async function stopDaemon(): Promise<void> {
  if (isShuttingDown) {
    // Wait for shutdown to complete (with timeout)
    const maxWaitMs = 10000; // 10 seconds timeout
    const startWait = daemonEnv.clock.now();
    while (gateway !== null || heartbeatRunner !== null) {
      if (daemonEnv.clock.now() - startWait > maxWaitMs) {
        throw new Error("Shutdown timeout: daemon failed to stop within 10 seconds");
      }
      await new Promise(resolve => daemonEnv.process.setTimeout(() => resolve(undefined), 50));
    }
    return;
  }

  isShuttingDown = true;

  console.log("[daemon-engine] Shutting down...");

  // Stop heartbeat timer
  if (heartbeatRunner) {
    heartbeatRunner.stop();
    heartbeatRunner = null;
    console.log("[daemon-engine] Heartbeat stopped");
  }

  // Stop gateway
  if (gateway) {
    await gateway.stop();
    gateway = null;
    console.log("[daemon-engine] Gateway stopped");
  }

  // Clear session store reference
  sessionStore = null;

  isShuttingDown = false;

  console.log("[daemon-engine] Shutdown complete");
}

/**
 * Handle shutdown signals.
 */
function handleShutdown(): void {
  console.log("[daemon-engine] Received shutdown signal");
  void stopDaemon().then(() => {
    daemonEnv.process.exit(0);
  });
}
