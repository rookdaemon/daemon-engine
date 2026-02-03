import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "daemon-config-test-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("loads and parses a valid YAML config", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: test-api-key

workspace: ~/.daemon-engine/workspace

server:
  port: 18800
`
    );

    const config = await loadConfig(configPath);

    expect(config.model.provider).toBe("anthropic");
    expect(config.model.name).toBe("claude-sonnet-4-20250514");
    expect(config.model.apiKey).toBe("test-api-key");
    expect(config.workspace).toBe("~/.daemon-engine/workspace");
    expect(config.server.port).toBe(18800);
  });

  it("loads and parses a valid JSON config", async () => {
    const configPath = join(configDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        model: {
          provider: "openai",
          name: "gpt-4",
          apiKey: "test-key",
        },
        workspace: "~/workspace",
        server: {
          port: 3000,
        },
      })
    );

    const config = await loadConfig(configPath);

    expect(config.model.provider).toBe("openai");
    expect(config.model.name).toBe("gpt-4");
    expect(config.model.apiKey).toBe("test-key");
    expect(config.workspace).toBe("~/workspace");
    expect(config.server.port).toBe(3000);
  });

  it("interpolates environment variables", async () => {
    process.env.TEST_API_KEY = "env-api-key";
    process.env.TEST_WORKSPACE = "/test/workspace";
    process.env.TEST_PORT = "9000";

    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: \${TEST_API_KEY}

workspace: \${TEST_WORKSPACE}

server:
  port: \${TEST_PORT}
`
    );

    const config = await loadConfig(configPath);

    expect(config.model.apiKey).toBe("env-api-key");
    expect(config.workspace).toBe("/test/workspace");
    expect(config.server.port).toBe(9000);

    delete process.env.TEST_API_KEY;
    delete process.env.TEST_WORKSPACE;
    delete process.env.TEST_PORT;
  });

  it("throws error if environment variable is not set", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: \${MISSING_ENV_VAR}

workspace: ~/workspace

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Environment variable not set: MISSING_ENV_VAR"
    );
  });

  it("throws error if config file does not exist", async () => {
    const configPath = join(configDir, "nonexistent.yaml");

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Config file not found:"
    );
  });

  it("throws error if model.provider is missing", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  name: claude-sonnet-4-20250514
  apiKey: test-key

workspace: ~/workspace

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: model.provider is required"
    );
  });

  it("throws error if model.name is missing", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  apiKey: test-key

workspace: ~/workspace

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: model.name is required"
    );
  });

  it("throws error if model.apiKey is missing", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514

workspace: ~/workspace

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: model.apiKey is required"
    );
  });

  it("throws error if workspace is missing", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: test-key

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: workspace is required"
    );
  });

  it("throws error if server.port is missing", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: test-key

workspace: ~/workspace

server: {}
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: server.port is required"
    );
  });

  it("throws error if provider is not anthropic or openai", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: invalid
  name: claude-sonnet-4-20250514
  apiKey: test-key

workspace: ~/workspace

server:
  port: 18800
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      'Invalid config: model.provider must be "anthropic" or "openai"'
    );
  });

  it("throws error if port is not a number", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  apiKey: test-key

workspace: ~/workspace

server:
  port: not-a-number
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Invalid config: server.port must be a number"
    );
  });

  it("throws error for invalid YAML syntax", async () => {
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      `
model:
  provider: anthropic
  name: [unclosed
workspace: ~/workspace
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Failed to parse config file:"
    );
  });

  it("throws error for invalid JSON syntax", async () => {
    const configPath = join(configDir, "config.json");
    await writeFile(configPath, '{ invalid json }');

    await expect(loadConfig(configPath)).rejects.toThrow(
      "Failed to parse config file:"
    );
  });
});
