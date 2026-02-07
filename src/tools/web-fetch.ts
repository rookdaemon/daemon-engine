/**
 * web-fetch.ts — Fetch URL content and extract readable text.
 *
 * Fetches a URL and extracts its readable text content.
 * Handles HTML (strips tags), plain text, JSON, and binary content types.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface WebFetchParams {
  /** URL to fetch. */
  url: string;
  /** Maximum content length to return in characters (default: 50000). */
  max_length?: number;
}

/**
 * Strip HTML tags and extract readable text.
 *
 * Uses regex-based approach (no external dependencies):
 * - Removes script and style blocks
 * - Converts block elements to newlines
 * - Strips all HTML tags
 * - Decodes basic HTML entities
 * - Collapses multiple blank lines
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Web fetch tool — fetches URL and extracts readable text.
 *
 * Validates URL format, fetches with 30s timeout, extracts text based on content-type.
 */
export const webFetch: ToolDefinition<WebFetchParams> = {
  description: "Fetch a URL and extract its readable text content.",

  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from.",
      },
      max_length: {
        type: "number",
        description: "Maximum content length in characters (default: 50000).",
      },
    },
    required: ["url"],
  },

  async execute(params: WebFetchParams, context: ToolContext): Promise<string> {
    return await webFetchWithEnv(params, context.env);
  },
};

export async function webFetchWithEnv(
  params: WebFetchParams,
  env: Environment
): Promise<string> {
  const { url, max_length = 50000 } = params;

  // Validate URL format
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Invalid URL: must start with http:// or https://");
  }

  // Set up timeout with AbortController
  const controller = new AbortController();
  const timeoutId = env.process.setTimeout(() => controller.abort(), 30000);

  try {
    // Fetch the URL
    const response = await env.http.fetch(url, { signal: controller.signal });

    // Check for non-2xx status
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }

    // Get content-type header
    const contentType = response.headers.get("content-type") || "";

    // Read response body as text
    const text = await response.text();

    let extractedText: string;

    // Handle different content types
    if (contentType.includes("text/html")) {
      // Strip HTML tags
      extractedText = stripHtml(text);
    } else if (
      contentType.includes("text/plain") ||
      contentType.includes("text/markdown") ||
      contentType.includes("application/json")
    ) {
      // Return raw text
      extractedText = text;
    } else if (contentType.startsWith("text/")) {
      // Other text types - return raw
      extractedText = text;
    } else {
      // Binary content
      return `Binary content (${contentType}), cannot extract text`;
    }

    // Truncate if necessary
    if (extractedText.length > max_length) {
      return extractedText.slice(0, max_length) + `\n\n[Truncated at ${max_length} characters]`;
    }

    return extractedText;
  } catch (error) {
    // Handle AbortError (timeout)
    if ((error as Error).name === "AbortError") {
      throw new Error(`Timeout fetching ${url} after 30s`);
    }

    // Handle other network errors
    if (error instanceof Error) {
      // Re-throw if it's already one of our formatted errors
      if (error.message.startsWith("HTTP ") || error.message.startsWith("Invalid URL")) {
        throw error;
      }
      throw new Error(`Failed to fetch ${url}: ${error.message}`);
    }

    throw error;
  } finally {
    env.process.clearTimeout(timeoutId);
  }
}
