/**
 * gateway.ts — HTTP server and request handling.
 *
 * Provides the main HTTP server for daemon-engine, with health check
 * and agent message endpoints.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import type { Config } from "./config.js";

/** Provider interface (minimal stub). */
export interface Provider {
  name: string;
}

/** Tool registry interface (minimal stub). */
export interface ToolRegistry {
  [key: string]: unknown;
}

/** Server dependencies. */
export interface ServerDependencies {
  provider: Provider;
  tools: ToolRegistry;
}

/**
 * Create an HTTP server for daemon-engine.
 *
 * Sets up routes for health check and agent communication.
 *
 * @param config - Runtime configuration.
 * @param deps - Server dependencies (provider, tools).
 * @returns HTTP server instance.
 */
export function createServer(config: Config, deps: ServerDependencies): Server {
  // deps will be used in the future for tools and provider
  void deps;
  const server = createHttpServer((req, res) => {
    const url = req.url || "/";

    // Health check endpoint
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: "0.1.0",
          agents: config.agents.length,
          model: config.agents[0]?.model || "none",
        })
      );
      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  return server;
}
