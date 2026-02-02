import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test that main module exports exist and are importable
describe("main module exports", () => {
  it("exports all public functions from index", async () => {
    const mod = await import("../src/index.js");

    // Config exports
    expect(typeof mod.loadConfig).toBe("function");

    // Workspace exports
    expect(typeof mod.buildSystemPrompt).toBe("function");
    expect(Array.isArray(mod.WORKSPACE_FILES)).toBe(true);

    // Gateway exports
    expect(typeof mod.createServer).toBe("function");

    // Heartbeat exports
    expect(typeof mod.startHeartbeat).toBe("function");
    expect(typeof mod.stopHeartbeat).toBe("function");

    // Provider exports
    expect(typeof mod.createAnthropicProvider).toBe("function");
  });
});

// Integration test: verify server can start and respond to /health
describe("server integration", () => {
  let configDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "daemon-engine-int-"));
    workspaceDir = join(configDir, "workspace");
    await mkdir(workspaceDir);
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("starts server and responds to health check", async () => {
    // Create minimal workspace files
    await writeFile(join(workspaceDir, "SOUL.md"), "I am a test agent.");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Follow instructions.");

    // Create minimal config
    const configYaml = `
agents:
  - id: integration-test
    workspace: ${workspaceDir}
    model: claude-3-5-sonnet-20241022

port: 3099
`;
    await writeFile(join(configDir, "config.yaml"), configYaml);

    // Load config and create server
    const { loadConfig } = await import("../src/config.js");
    const { buildSystemPrompt } = await import("../src/workspace.js");
    const { createAnthropicProvider } = await import("../src/provider.js");
    const { createServer } = await import("../src/gateway.js");

    const config = await loadConfig(configDir);
    expect(config.agents).toHaveLength(1);

    // Build system prompt
    const systemPrompt = await buildSystemPrompt(config.agents[0].workspace);
    expect(systemPrompt).toContain("I am a test agent.");

    // Create provider and server
    const provider = createAnthropicProvider("test-key");
    const server = createServer(config, { provider, tools: {} });

    return new Promise<void>((resolve, reject) => {
      server.listen(3099, () => {
        // Make request to /health
        import("http")
          .then((http) => {
            http.get("http://localhost:3099/health", (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                try {
                  expect(res.statusCode).toBe(200);
                  const json = JSON.parse(data);
                  expect(json.status).toBe("ok");
                  expect(json.agents).toBe(1);
                  expect(json.model).toBe("claude-3-5-sonnet-20241022");
                  server.close(() => resolve());
                } catch (err) {
                  server.close(() => reject(err));
                }
              });
            });
          })
          .catch((err) => {
            server.close(() => reject(err));
          });
      });
    });
  });

  it("handles multiple agents in config", async () => {
    const workspace2 = join(configDir, "workspace2");
    await mkdir(workspace2);

    const configYaml = `
agents:
  - id: agent-1
    workspace: ${workspaceDir}
    model: claude-3-5-sonnet-20241022
  - id: agent-2
    workspace: ${workspace2}
    model: claude-3-opus-20240229

port: 3098
`;
    await writeFile(join(configDir, "config.yaml"), configYaml);

    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig(configDir);

    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].id).toBe("agent-1");
    expect(config.agents[1].id).toBe("agent-2");
  });
});
