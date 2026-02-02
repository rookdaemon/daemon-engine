import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "daemon-engine-config-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("loads a minimal config with one agent", async () => {
    const configYaml = `
agents:
  - id: test-agent
    workspace: /tmp/workspace
    model: claude-3-5-sonnet-20241022
    tools: []

port: 3000
`;
    await writeFile(join(configDir, "config.yaml"), configYaml);

    const config = await loadConfig(configDir);

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe("test-agent");
    expect(config.agents[0].workspace).toBe("/tmp/workspace");
    expect(config.agents[0].model).toBe("claude-3-5-sonnet-20241022");
    expect(config.port).toBe(3000);
  });

  it("uses default port if not specified", async () => {
    const configYaml = `
agents:
  - id: test-agent
    workspace: /tmp/workspace
    model: claude-3-5-sonnet-20241022
`;
    await writeFile(join(configDir, "config.yaml"), configYaml);

    const config = await loadConfig(configDir);

    expect(config.port).toBe(3000);
  });

  it("supports heartbeat configuration", async () => {
    const configYaml = `
agents:
  - id: test-agent
    workspace: /tmp/workspace
    model: claude-3-5-sonnet-20241022

heartbeat:
  enabled: true
  intervalSeconds: 300
`;
    await writeFile(join(configDir, "config.yaml"), configYaml);

    const config = await loadConfig(configDir);

    expect(config.heartbeat).toBeDefined();
    expect(config.heartbeat?.enabled).toBe(true);
    expect(config.heartbeat?.intervalSeconds).toBe(300);
  });
});
