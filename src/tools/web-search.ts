/**
 * web-search.ts — Web search via Brave Search API.
 *
 * Queries the Brave Search API and returns formatted results.
 * Requires BRAVE_API_KEY environment variable.
 */

import type { ToolDefinition, ToolContext } from "../agent.js";
import type { Environment } from "../env/environment.js";

interface WebSearchParams {
  /** Search query string. */
  query: string;
  /** Number of results to return (default: 5, max: 20). */
  count?: number;
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}

/**
 * Web search tool — queries Brave Search API.
 *
 * Returns formatted search results with title, URL, and description.
 */
export const webSearch: ToolDefinition<WebSearchParams> = {
  description: "Search the web using Brave Search API and return formatted results.",

  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
      count: {
        type: "number",
        description: "Number of results to return (default: 5, max: 20).",
      },
    },
    required: ["query"],
  },

  async execute(params: WebSearchParams, context: ToolContext): Promise<string> {
    return await webSearchWithEnv(params, context.env);
  },
};

export async function webSearchWithEnv(
  params: WebSearchParams,
  env: Environment
): Promise<string> {
  const { query } = params;
  
  // Clamp count to valid range [1, 20], default to 5
  const count = Math.max(1, Math.min(params.count ?? 5, 20));

  // Get API key from environment
  const apiKey = env.process.env("BRAVE_API_KEY");
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY environment variable is not set");
  }

  // Build the API URL
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

  // Make the API request
  const response = await env.http.fetch(url, {
    method: "GET",
    headers: {
      "X-Subscription-Token": apiKey,
      "Accept": "application/json",
    },
  });

  // Handle non-200 responses
  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  // Parse the response
  let data: BraveSearchResponse;
  try {
    data = await response.json() as BraveSearchResponse;
  } catch {
    throw new Error("Unexpected response format from Brave Search API");
  }

  // Extract results
  const results = data.web?.results ?? [];

  // Handle empty results
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  // Format results
  const formatted = results.map((result, index) => {
    return `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.description}`;
  });

  return formatted.join("\n\n");
}
