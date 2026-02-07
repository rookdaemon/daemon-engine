import { describe, it, expect, vi, beforeEach } from "vitest";
import { message, messageWithEnv } from "../src/tools/message.js";
import type { Config } from "../src/config.js";
import type { Environment } from "../src/env/environment.js";
import { createTestContext } from "./fakes/test-context.js";

describe("message tool", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockEnv: Environment;
  let config: Config;

  beforeEach(() => {
    mockFetch = vi.fn();
    
    // Create a minimal mock environment with just the http.fetch we need
    mockEnv = {
      http: {
        fetch: mockFetch,
        createServer: vi.fn(),
      },
    } as unknown as Environment;

    // Create a minimal config with channels
    config = {
      model: {
        provider: "anthropic",
        name: "test-model",
        apiKey: "test-key",
      },
      workspace: "/test/workspace",
      server: {
        port: 3000,
      },
      channels: {
        "discord-general": {
          type: "discord-webhook",
          url: "https://discord.com/api/webhooks/123/abc",
        },
        "matrix-ops": {
          type: "matrix",
          homeserver: "https://matrix.example.com",
          room_id: "!room:example.com",
          access_token: "test_token_123",
        },
        "alerts": {
          type: "webhook",
          url: "https://example.com/webhook",
          method: "POST",
          headers: {
            "X-Custom-Header": "value",
          },
          body_template: '{"text": "{{content}}"}',
        },
        "simple-webhook": {
          type: "webhook",
          url: "https://example.com/simple",
        },
      },
    };
  });

  describe("Discord webhook", () => {
    it("sends message to Discord webhook", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const result = await messageWithEnv(
        { channel: "discord-general", content: "Hello Discord!" },
        mockEnv,
        config
      );

      expect(result).toBe("Message sent to discord-webhook");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/abc",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: "Hello Discord!" }),
        }
      );
    });

    it("truncates content to 2000 characters for Discord", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const longContent = "a".repeat(2500);
      await messageWithEnv(
        { channel: "discord-general", content: longContent },
        mockEnv,
        config
      );

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.content.length).toBe(2000);
    });

    it("throws error on Discord webhook failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(
        messageWithEnv(
          { channel: "discord-general", content: "Test" },
          mockEnv,
          config
        )
      ).rejects.toThrow("Failed to send to Discord webhook: 404 Not Found");
    });
  });

  describe("Matrix", () => {
    it("sends message to Matrix room", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const result = await messageWithEnv(
        { channel: "matrix-ops", content: "Hello Matrix!" },
        mockEnv,
        config
      );

      expect(result).toBe("Message sent to matrix");
      
      const call = mockFetch.mock.calls[0];
      const url = call[0] as string;
      
      // Verify URL structure (transaction ID will vary)
      expect(url).toContain("https://matrix.example.com/_matrix/client/v3/rooms/");
      expect(url).toContain(encodeURIComponent("!room:example.com"));
      expect(url).toContain("/send/m.room.message/daemon-");

      // Verify headers and body
      expect(call[1].method).toBe("PUT");
      expect(call[1].headers).toEqual({
        "Authorization": "Bearer test_token_123",
        "Content-Type": "application/json",
      });
      
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({
        msgtype: "m.text",
        body: "Hello Matrix!",
      });
    });

    it("throws error on Matrix failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      await expect(
        messageWithEnv(
          { channel: "matrix-ops", content: "Test" },
          mockEnv,
          config
        )
      ).rejects.toThrow("Failed to send to Matrix room: 403 Forbidden");
    });
  });

  describe("Generic webhook", () => {
    it("sends message with custom template", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const result = await messageWithEnv(
        { channel: "alerts", content: "Alert message" },
        mockEnv,
        config
      );

      expect(result).toBe("Message sent to webhook");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/webhook",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Custom-Header": "value",
          },
          body: '{"text": "Alert message"}',
        }
      );
    });

    it("uses default JSON body when no template provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      await messageWithEnv(
        { channel: "simple-webhook", content: "Simple message" },
        mockEnv,
        config
      );

      const call = mockFetch.mock.calls[0];
      expect(call[1].body).toBe(JSON.stringify({ content: "Simple message" }));
    });

    it("escapes special characters in template content", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      // Content with various JSON special characters that need escaping
      // Using actual special characters, not escaped string literals
      const contentWithSpecialChars = 'Message with "quotes", \\backslashes, \nnewlines, \ttabs, and /slashes/';
      
      await messageWithEnv(
        { channel: "alerts", content: contentWithSpecialChars },
        mockEnv,
        config
      );

      const call = mockFetch.mock.calls[0];
      const body = call[1].body;
      
      // Verify the body is valid JSON (doesn't throw)
      expect(() => JSON.parse(body)).not.toThrow();
      
      // Verify the content is properly escaped in the template
      const parsed = JSON.parse(body);
      expect(parsed.text).toBe(contentWithSpecialChars);
    });

    it("throws error on webhook failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        messageWithEnv(
          { channel: "alerts", content: "Test" },
          mockEnv,
          config
        )
      ).rejects.toThrow("Failed to send to webhook: 500 Internal Server Error");
    });
  });

  describe("Error handling", () => {
    it("throws error when no channels configured", async () => {
      const configWithoutChannels: Config = {
        model: config.model,
        workspace: config.workspace,
        server: config.server,
      };

      await expect(
        messageWithEnv(
          { channel: "any", content: "Test" },
          mockEnv,
          configWithoutChannels
        )
      ).rejects.toThrow("No channels configured. Add a 'channels' section to your config.");
    });

    it("throws error when no config provided", async () => {
      await expect(
        messageWithEnv(
          { channel: "any", content: "Test" },
          mockEnv,
          undefined
        )
      ).rejects.toThrow("No channels configured. Add a 'channels' section to your config.");
    });

    it("throws error for unknown channel", async () => {
      await expect(
        messageWithEnv(
          { channel: "unknown-channel", content: "Test" },
          mockEnv,
          config
        )
      ).rejects.toThrow(
        "Unknown channel: unknown-channel. Available channels: discord-general, matrix-ops, alerts, simple-webhook"
      );
    });

    it("lists available channels when channel not found", async () => {
      const error = await messageWithEnv(
        { channel: "nonexistent", content: "Test" },
        mockEnv,
        config
      ).catch((e) => e);

      expect(error.message).toContain("Available channels:");
      expect(error.message).toContain("discord-general");
      expect(error.message).toContain("matrix-ops");
    });
  });

  describe("Tool definition", () => {
    it("has correct description and parameters", () => {
      expect(message.description).toBeTruthy();
      expect(message.parameters.type).toBe("object");
      expect(message.parameters.properties.channel).toBeTruthy();
      expect(message.parameters.properties.content).toBeTruthy();
      expect(message.parameters.required).toContain("channel");
      expect(message.parameters.required).toContain("content");
    });

    it("executes through tool interface", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
      });

      const context = createTestContext("/test/workspace", mockEnv);
      context.config = config;

      const result = await message.execute(
        { channel: "discord-general", content: "Test" },
        context
      );

      expect(result).toBe("Message sent to discord-webhook");
    });
  });
});
