import { describe, it, expect } from "vitest";
import { createServer } from "../src/gateway.js";
import type { Config } from "../src/config.js";

describe("createServer", () => {
  it("creates an HTTP server with health endpoint", async () => {
    const config: Config = {
      agents: [],
      port: 3000,
    };

    const server = createServer(config, {
      provider: { name: "test" },
      tools: {},
    });

    expect(server).toBeDefined();
    expect(typeof server.listen).toBe("function");
    expect(typeof server.close).toBe("function");
  });

  it("responds to /health endpoint", async () => {
    const config: Config = {
      agents: [{ id: "test", workspace: "/tmp", model: "test-model" }],
      port: 3001,
    };

    const server = createServer(config, {
      provider: { name: "test" },
      tools: {},
    });

    return new Promise<void>((resolve, reject) => {
      server.listen(3001, () => {
        // Make a request to /health
        import("http")
          .then((http) => {
            http.get("http://localhost:3001/health", (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                expect(res.statusCode).toBe(200);
                const json = JSON.parse(data);
                expect(json.status).toBe("ok");
                expect(json.agents).toBe(1);
                server.close(() => resolve());
              });
            });
          })
          .catch(reject);
      });
    });
  });
});
