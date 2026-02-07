/**
 * message.ts — Send messages to communication channels (Discord, Matrix, webhooks).
 *
 * Enables the agent to proactively communicate through configured channels.
 * Supports Discord webhooks, Matrix rooms, and generic HTTP webhooks.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";
import type { Config, ChannelConfig } from "../config.js";

interface MessageParams {
  /** Channel identifier (matches a key in config channels section). */
  channel: string;
  /** Message content to send. */
  content: string;
}

/**
 * Message tool — sends messages to configured communication channels.
 *
 * Looks up the channel in the config and dispatches to the appropriate
 * channel type handler (Discord webhook, Matrix, or generic webhook).
 */
export const message: ToolDefinition<MessageParams> = {
  description: "Send a message to a communication channel (Discord, Matrix, or webhook).",

  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel identifier (e.g., 'discord-general', 'matrix-ops'). Must match a configured channel.",
      },
      content: {
        type: "string",
        description: "Message content to send.",
      },
    },
    required: ["channel", "content"],
  },

  async execute(params: MessageParams, context: ToolContext): Promise<string> {
    return await messageWithEnv(params, context.env, context.config);
  },
};

/**
 * Execute the message tool with explicit environment and config.
 * Separated for testability.
 */
export async function messageWithEnv(
  params: MessageParams,
  env: Environment,
  config?: Config
): Promise<string> {
  const { channel, content } = params;

  // Validate that config and channels are available
  if (!config || !config.channels) {
    throw new Error("No channels configured. Add a 'channels' section to your config.");
  }

  // Look up the channel in config
  const channelConfig = config.channels[channel];
  if (!channelConfig) {
    const availableChannels = Object.keys(config.channels).join(", ");
    throw new Error(
      `Unknown channel: ${channel}. Available channels: ${availableChannels || "(none)"}`
    );
  }

  // Dispatch to the appropriate channel type handler
  switch (channelConfig.type) {
    case "discord-webhook":
      return await sendDiscordWebhook(channelConfig, content, env);
    case "matrix":
      return await sendMatrix(channelConfig, content, env);
    case "webhook":
      return await sendGenericWebhook(channelConfig, content, env);
    default:
      // This should never happen due to TypeScript's exhaustive checking
      throw new Error(`Unsupported channel type: ${(channelConfig as ChannelConfig).type}`);
  }
}

/**
 * Send a message to a Discord webhook.
 */
async function sendDiscordWebhook(
  config: Extract<ChannelConfig, { type: "discord-webhook" }>,
  content: string,
  env: Environment
): Promise<string> {
  // Discord has a 2000 character limit on message content
  const truncatedContent = content.slice(0, 2000);

  const response = await env.http.fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: truncatedContent }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to send to Discord webhook: ${response.status} ${response.statusText}`
    );
  }

  return `Message sent to discord-webhook`;
}

/**
 * Send a message to a Matrix room.
 */
async function sendMatrix(
  config: Extract<ChannelConfig, { type: "matrix" }>,
  content: string,
  env: Environment
): Promise<string> {
  // Generate a unique transaction ID based on timestamp
  const txnId = `daemon-${Date.now()}`;

  const url = `${config.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(config.room_id)}/send/m.room.message/${txnId}`;

  const response = await env.http.fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${config.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msgtype: "m.text",
      body: content,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to send to Matrix room: ${response.status} ${response.statusText}`
    );
  }

  return `Message sent to matrix`;
}

/**
 * Send a message to a generic webhook.
 */
async function sendGenericWebhook(
  config: Extract<ChannelConfig, { type: "webhook" }>,
  content: string,
  env: Environment
): Promise<string> {
  const method = config.method || "POST";
  
  // Apply body template or use default
  let body: string;
  if (config.body_template) {
    body = config.body_template.replace(/\{\{content\}\}/g, content);
  } else {
    body = JSON.stringify({ content });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.headers,
  };

  const response = await env.http.fetch(config.url, {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to send to webhook: ${response.status} ${response.statusText}`
    );
  }

  return `Message sent to webhook`;
}
