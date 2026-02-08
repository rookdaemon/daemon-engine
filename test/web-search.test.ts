import { describe, it, expect } from "vitest";
import { webSearch } from "../src/tools/web-search.js";
import { createTestContext } from "./fakes/test-context.js";
import { createFakeEnvironment } from "./fakes/fake-environment.js";
import type { ToolContext } from "../src/agent.js";
import type { Environment } from "../src/env/environment.js";

describe("web_search tool", () => {
  function createMockFetch(
    mockResponse: unknown,
    status = 200,
    statusText = "OK"
  ): (input: string | URL, init?: RequestInit) => Promise<Response> {
    return async () => {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => mockResponse,
      } as Response;
    };
  }

  it("returns formatted results from valid API response", async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: "Example Result 1",
            url: "https://example.com/1",
            description: "This is the first result description.",
          },
          {
            title: "Example Result 2",
            url: "https://example.com/2",
            description: "This is the second result description.",
          },
        ],
      },
    };

    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: createMockFetch(mockResponse),
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    const result = await webSearch.execute({ query: "test query" }, context);

    expect(result).toContain("[1] Example Result 1");
    expect(result).toContain("URL: https://example.com/1");
    expect(result).toContain("This is the first result description.");
    expect(result).toContain("[2] Example Result 2");
    expect(result).toContain("URL: https://example.com/2");
    expect(result).toContain("This is the second result description.");
  });

  it("throws when BRAVE_API_KEY is not set", async () => {
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: () => undefined, // No API key
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);

    await expect(
      webSearch.execute({ query: "test query" }, context)
    ).rejects.toThrow("BRAVE_API_KEY environment variable is not set");
  });

  it("handles empty results array", async () => {
    const mockResponse = {
      web: {
        results: [],
      },
    };

    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: createMockFetch(mockResponse),
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    const result = await webSearch.execute({ query: "test query" }, context);

    expect(result).toBe("No results found for: test query");
  });

  it("handles API error responses (429)", async () => {
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: createMockFetch({}, 429, "Too Many Requests"),
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);

    await expect(
      webSearch.execute({ query: "test query" }, context)
    ).rejects.toThrow("Brave Search API error: 429 Too Many Requests");
  });

  it("handles API error responses (500)", async () => {
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: createMockFetch({}, 500, "Internal Server Error"),
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);

    await expect(
      webSearch.execute({ query: "test query" }, context)
    ).rejects.toThrow("Brave Search API error: 500 Internal Server Error");
  });

  it("respects count parameter with default of 10", async () => {
    let capturedUrl = "";
    
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: async (input: string | URL) => {
          capturedUrl = String(input);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ web: { results: [] } }),
          } as Response;
        },
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    await webSearch.execute({ query: "test query" }, context);

    // Default count should be 10
    expect(capturedUrl).toContain("count=10");
  });

  it("respects custom count parameter", async () => {
    let capturedUrl = "";
    
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: async (input: string | URL) => {
          capturedUrl = String(input);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ web: { results: [] } }),
          } as Response;
        },
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    await webSearch.execute({ query: "test query", count: 10 }, context);

    expect(capturedUrl).toContain("count=10");
  });

  it("clamps count to max of 20", async () => {
    let capturedUrl = "";
    
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: async (input: string | URL) => {
          capturedUrl = String(input);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ web: { results: [] } }),
          } as Response;
        },
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    await webSearch.execute({ query: "test query", count: 100 }, context);

    // Should be clamped to 20
    expect(capturedUrl).toContain("count=20");
  });

  it("clamps count to min of 1", async () => {
    let capturedUrl = "";
    
    const env: Environment = createFakeEnvironment({
      process: {
        platform: () => process.platform,
        env: (key: string) => (key === "BRAVE_API_KEY" ? "test-api-key" : undefined),
        on: () => {},
        exit: (code: number) => process.exit(code),
        setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
        clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
        setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
        clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
      },
      http: {
        createServer: () => {
          throw new Error("Not implemented");
        },
        fetch: async (input: string | URL) => {
          capturedUrl = String(input);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ web: { results: [] } }),
          } as Response;
        },
      },
    });

    const context: ToolContext = createTestContext("/tmp/test", env);
    await webSearch.execute({ query: "test query", count: 0 }, context);

    // Should be clamped to 1
    expect(capturedUrl).toContain("count=1");
  });

  it("has correct description and parameters", () => {
    expect(webSearch.description).toBeTruthy();
    expect(webSearch.parameters.type).toBe("object");
    expect(webSearch.parameters.properties.query).toBeTruthy();
    expect(webSearch.parameters.properties.count).toBeTruthy();
    expect(webSearch.parameters.required).toContain("query");
    expect(webSearch.parameters.required).not.toContain("count");
  });
});
