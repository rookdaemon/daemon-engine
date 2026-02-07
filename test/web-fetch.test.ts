import { describe, it, expect, vi } from "vitest";
import { webFetch, webFetchWithEnv } from "../src/tools/web-fetch.js";
import { createFakeEnvironment } from "./fakes/fake-environment.js";
import { createTestContext } from "./fakes/test-context.js";

describe("web_fetch tool", () => {
  it("extracts text from HTML response", async () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello World</h1>
          <p>This is a test.</p>
          <script>console.log('ignore me');</script>
        </body>
      </html>
    `;

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com" }, env);

    expect(result).toContain("Hello World");
    expect(result).toContain("This is a test.");
    expect(result).not.toContain("<h1>");
    expect(result).not.toContain("console.log");
  });

  it("returns raw text for plain text response", async () => {
    const plainText = "This is plain text content.";

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => plainText,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com/file.txt" }, env);

    expect(result).toBe(plainText);
  });

  it("returns raw text for JSON response", async () => {
    const jsonContent = '{"key": "value", "number": 42}';

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/json"]]),
          text: async () => jsonContent,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://api.example.com/data.json" }, env);

    expect(result).toBe(jsonContent);
  });

  it("returns raw text for markdown response", async () => {
    const markdown = "# Title\n\nThis is **markdown**.";

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/markdown"]]),
          text: async () => markdown,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com/README.md" }, env);

    expect(result).toBe(markdown);
  });

  it("handles binary content type gracefully", async () => {
    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "application/pdf"]]),
          text: async () => "binary data",
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com/file.pdf" }, env);

    expect(result).toBe("Binary content (application/pdf), cannot extract text");
  });

  it("truncates at max_length", async () => {
    const longText = "A".repeat(100000);

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => longText,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com", max_length: 1000 }, env);

    expect(result).toHaveLength(1000 + "\n\n[Truncated at 1000 characters]".length);
    expect(result).toContain("[Truncated at 1000 characters]");
  });

  it("uses default max_length of 50000", async () => {
    const longText = "B".repeat(60000);

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => longText,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com" }, env);

    expect(result).toContain("[Truncated at 50000 characters]");
  });

  it("throws on invalid URL format (missing protocol)", async () => {
    const env = createFakeEnvironment();

    await expect(
      webFetchWithEnv({ url: "example.com" }, env)
    ).rejects.toThrow("Invalid URL: must start with http:// or https://");
  });

  it("throws on invalid URL format (ftp protocol)", async () => {
    const env = createFakeEnvironment();

    await expect(
      webFetchWithEnv({ url: "ftp://example.com" }, env)
    ).rejects.toThrow("Invalid URL: must start with http:// or https://");
  });

  it("throws on non-2xx status", async () => {
    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          headers: new Map(),
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    await expect(
      webFetchWithEnv({ url: "https://example.com/notfound" }, env)
    ).rejects.toThrow("HTTP 404 fetching https://example.com/notfound");
  });

  it("throws on network error", async () => {
    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockRejectedValue(new Error("Network error")),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    await expect(
      webFetchWithEnv({ url: "https://example.com" }, env)
    ).rejects.toThrow("Failed to fetch https://example.com: Network error");
  });

  it("throws on timeout", async () => {
    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockImplementation(async (_url, init) => {
          // Immediately trigger abort to simulate timeout
          if (init?.signal) {
            // Simulate abort after setTimeout is called
            setTimeout(() => {
              const controller = new AbortController();
              controller.abort();
              const event = new Event("abort");
              init.signal?.dispatchEvent(event);
            }, 0);
          }
          // Simulate timeout by calling abort after a delay
          return new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener("abort", () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              });
            }
          });
        }),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn((fn) => {
          // Immediately call the abort function to simulate timeout
          fn();
          return { ref: () => {}, unref: () => {} } as NodeJS.Timeout;
        }),
        clearTimeout: vi.fn(),
      },
    });

    await expect(
      webFetchWithEnv({ url: "https://example.com" }, env)
    ).rejects.toThrow("Timeout fetching https://example.com after 30s");
  });

  it("removes script and style blocks from HTML", async () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
        </head>
        <body>
          <p>Visible content</p>
          <script>alert('hidden');</script>
          <p>More visible content</p>
        </body>
      </html>
    `;

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com" }, env);

    expect(result).toContain("Visible content");
    expect(result).toContain("More visible content");
    expect(result).not.toContain("color: red");
    expect(result).not.toContain("alert");
  });

  it("converts block elements to newlines", async () => {
    const html = `
      <div>First div</div>
      <p>Paragraph</p>
      <h1>Heading</h1>
      <li>List item</li>
    `;

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com" }, env);

    // Each block element should be on its own line
    expect(result).toMatch(/First div\s*\n/);
    expect(result).toMatch(/Paragraph\s*\n/);
    expect(result).toMatch(/Heading\s*\n/);
    expect(result).toMatch(/List item/);
  });

  it("decodes HTML entities", async () => {
    const html = `<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>`;

    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => html,
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const result = await webFetchWithEnv({ url: "https://example.com" }, env);

    expect(result).toContain("& < > \" '");
  });

  it("has correct description and parameters", () => {
    expect(webFetch.description).toBeTruthy();
    expect(webFetch.parameters.type).toBe("object");
    expect(webFetch.parameters.properties.url).toBeTruthy();
    expect(webFetch.parameters.properties.max_length).toBeTruthy();
    expect(webFetch.parameters.required).toContain("url");
  });

  it("works via execute method", async () => {
    const env = createFakeEnvironment({
      http: {
        fetch: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Map([["content-type", "text/plain"]]),
          text: async () => "Test content",
        } as unknown as Response),
        createServer: vi.fn(),
      },
      process: {
        ...createFakeEnvironment().process,
        setTimeout: vi.fn(() => ({ ref: () => {}, unref: () => {} } as NodeJS.Timeout)),
        clearTimeout: vi.fn(),
      },
    });

    const context = createTestContext("/tmp/test", env);
    const result = await webFetch.execute({ url: "https://example.com" }, context);

    expect(result).toBe("Test content");
  });
});
