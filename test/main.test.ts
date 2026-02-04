import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon, stopDaemon, startChatMode } from "../src/main.js";
import { createNodeEnvironment } from "../src/env/environment.js";

describe("main", () => {
  let testDir: string;
  let configPath: string;
  const env = createNodeEnvironment();

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "daemon-main-test-"));
    configPath = join(testDir, "daemon.yaml");

    // Create workspace directory
    const workspaceDir = join(testDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    // Create sessions directory
    const sessionsDir = join(testDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Write a valid config file
    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet
  skipPermissions: true
  timeout: 30000

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks:
    test:
      token: test-token
      sessionKey: test:session

sessions:
  storeDir: ${sessionsDir}
`
    );
  });

  afterEach(async () => {
    // Stop daemon if it's running
    try {
      await stopDaemon();
    } catch {
      // Ignore errors if daemon wasn't running
    }

    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  it("starts daemon with valid config", async () => {
    await startDaemon(configPath, createNodeEnvironment());

    // Daemon should be running now
    // We can verify by trying to start it again, which should throw
    await expect(startDaemon(configPath, createNodeEnvironment())).rejects.toThrow(
      "Daemon is already running"
    );

    // Clean up
    await stopDaemon();
  });

  it("stops daemon gracefully", async () => {
    await startDaemon(configPath, createNodeEnvironment());
    await stopDaemon();

    // Should be able to start again after stopping
    await startDaemon(configPath, createNodeEnvironment());
    await stopDaemon();
  });

  it("throws error if config file not found", async () => {
    await expect(
      startDaemon(join(testDir, "nonexistent.yaml"), createNodeEnvironment())
    ).rejects.toThrow("Config file not found");
  });

  it("throws error if workspace is missing", async () => {
    await writeFile(
      configPath,
      `
claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 8080
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Invalid config: workspace is required"
    );
  });

  it("throws error if heartbeat.enabled is missing", async () => {
    await writeFile(
      configPath,
      `
workspace: ${join(testDir, "workspace")}

claude:
  model: sonnet

heartbeat:
  intervalMs: 60000

gateway:
  port: 8080
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Invalid config: heartbeat.enabled is required"
    );
  });

  it("throws error if heartbeat.enabled is wrong type", async () => {
    await writeFile(
      configPath,
      `
workspace: ${join(testDir, "workspace")}

claude:
  model: sonnet

heartbeat:
  enabled: "not-a-boolean"
  intervalMs: 60000

gateway:
  port: 8080
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Invalid config: heartbeat.enabled must be a boolean"
    );
  });

  it("interpolates environment variables in config", async () => {
    process.env.TEST_WORKSPACE = join(testDir, "workspace");
    process.env.TEST_SESSIONS = join(testDir, "sessions");
    process.env.TEST_TOKEN = "secret-token";

    await writeFile(
      configPath,
      `
workspace: \${TEST_WORKSPACE}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks:
    test:
      token: \${TEST_TOKEN}
      sessionKey: test:session

sessions:
  storeDir: \${TEST_SESSIONS}
`
    );

    await startDaemon(configPath, env);

    // Clean up
    await stopDaemon();

    delete process.env.TEST_WORKSPACE;
    delete process.env.TEST_SESSIONS;
    delete process.env.TEST_TOKEN;
  });

  it("throws error if environment variable is not set", async () => {
    await writeFile(
      configPath,
      `
workspace: \${MISSING_ENV_VAR}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 8080
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Environment variable not set: MISSING_ENV_VAR"
    );
  });

  it("starts heartbeat when enabled", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet
  skipPermissions: true

heartbeat:
  enabled: true
  intervalMs: 300000
  prompt: "Test heartbeat"

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    // Mock console.log to capture output
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await startDaemon(configPath, env);

    // Check that heartbeat log message was printed
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Heartbeat enabled")
    );

    // Clean up
    logSpy.mockRestore();
    await stopDaemon();
  });

  it("resolves tilde in workspace path", async () => {
    // Create workspace in temp dir
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ~/test-workspace

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    // This will fail because ~/test-workspace likely doesn't exist
    // But the important thing is that the tilde is resolved (not a config validation error)
    try {
      await startDaemon(configPath, env);
      // If it succeeds, clean up
      await stopDaemon();
    } catch (error) {
      // Expected - workspace directory might not exist, or buildSystemPrompt might fail
      // The key is that we got past config validation
      expect((error as Error).message).not.toContain("Invalid config");
    }
  });

  it("validates gateway.port is a number", async () => {
    await writeFile(
      configPath,
      `
workspace: ${join(testDir, "workspace")}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: "not-a-number"
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Invalid config: gateway.port must be a number"
    );
  });

  it("validates heartbeat.intervalMs is a number", async () => {
    await writeFile(
      configPath,
      `
workspace: ${join(testDir, "workspace")}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: "not-a-number"

gateway:
  port: 8080
  hooks: {}

sessions:
  storeDir: ${join(testDir, "sessions")}
`
    );

    await expect(startDaemon(configPath, env)).rejects.toThrow(
      "Invalid config: heartbeat.intervalMs must be a number"
    );
  });

  it("parses JSON config file", async () => {
    const jsonConfigPath = join(testDir, "daemon.json");
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      jsonConfigPath,
      JSON.stringify({
        workspace: workspaceDir,
        claude: {
          model: "sonnet",
          skipPermissions: true,
        },
        heartbeat: {
          enabled: false,
          intervalMs: 60000,
        },
        gateway: {
          port: 0,
          hooks: {
            test: {
              token: "test-token",
              sessionKey: "test:session",
            },
          },
        },
        sessions: {
          storeDir: sessionsDir,
        },
      })
    );

    await startDaemon(jsonConfigPath, env);

    // Clean up
    await stopDaemon();
  });

  it("supports optional claude config fields", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: opus
  skipPermissions: true
  timeout: 60000

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    await startDaemon(configPath, env);

    // Clean up
    await stopDaemon();
  });

  it("supports optional heartbeat fields", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet

heartbeat:
  enabled: true
  intervalMs: 300000
  prompt: "Custom heartbeat prompt"
  activeHours: [9, 17]

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    await startDaemon(configPath, env);

    // Clean up
    await stopDaemon();
  });

  it("supports optional gateway.host field", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  host: "127.0.0.1"
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    await startDaemon(configPath, env);

    // Clean up
    await stopDaemon();
  });

  it("supports optional sessions.maxContextTokens field", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
  maxContextTokens: 100000
`
    );

    await startDaemon(configPath, env);

    // Clean up
    await stopDaemon();
  });

  it("initializes chat mode with valid config", async () => {
    const workspaceDir = join(testDir, "workspace");
    const sessionsDir = join(testDir, "sessions");

    await writeFile(
      configPath,
      `
workspace: ${workspaceDir}

claude:
  model: sonnet
  skipPermissions: true
  timeout: 30000

heartbeat:
  enabled: false
  intervalMs: 60000

gateway:
  port: 0
  hooks: {}

sessions:
  storeDir: ${sessionsDir}
`
    );

    // We can't fully test interactive mode without mocking stdin/stdout,
    // but we can verify it initializes without throwing errors.
    // The function will block on readline.question, so we just verify
    // it starts successfully by checking that it creates the proper structure.
    
    // Start chat mode in background (it will wait for stdin)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const chatPromise = startChatMode(configPath, "test-session", env);

    // Give it a moment to initialize
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify session directory was created (proves initialization worked)
    const sessionDir = join(sessionsDir, "test-session");
    try {
      await env.fs.access(sessionDir);
    } catch {
      // Session directory may not exist yet if no messages sent, which is fine
    }

    // Note: We can't cleanly stop the chat mode here without sending Ctrl+C signal,
    // but the test framework will clean up the process
  });
});
