/**
 * anthropic-oauth-credentials.ts — OAuth credential resolution for Anthropic session tokens.
 *
 * Resolves session tokens from config, env, or credential store.
 * Refreshes expired tokens when using credential store.
 * Ported from pi-mono packages/ai/src/utils/oauth/anthropic.ts
 */

import type { Environment } from "../env/environment.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

/**
 * Check if a token is an OAuth session token (sk-ant-oat).
 */
export function isOAuthToken(token: string): boolean {
  return token.includes("sk-ant-oat");
}

/**
 * Refresh Anthropic OAuth token using refresh_token grant.
 */
export async function refreshAnthropicToken(
  refreshToken: string,
  env: Environment
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic token refresh failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: env.clock.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

export interface ResolveSessionTokenParams {
  /** Session token from config (sk-ant-oat string) */
  sessionToken?: string;
  /** Path to credential store JSON file */
  credentialStorePath?: string;
  /** Environment for fs, path, process, clock */
  env: Environment;
}

/**
 * Resolve a valid session token for API calls.
 * Priority: (1) config sessionToken, (2) ANTHROPIC_OAUTH_TOKEN env, (3) credential store file.
 * If store is used and token expired, refreshes and persists.
 */
export async function resolveSessionToken(params: ResolveSessionTokenParams): Promise<string> {
  const { sessionToken, credentialStorePath, env } = params;

  // 1. Config session token
  const configToken = sessionToken?.trim();
  if (configToken && configToken.length > 0) {
    return configToken;
  }

  // 2. Environment variable
  const envToken = env.process.env("ANTHROPIC_OAUTH_TOKEN")?.trim();
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  // 3. Credential store file
  if (credentialStorePath) {
    try {
      const content = await env.fs.readFile(credentialStorePath, "utf-8");
      const creds = JSON.parse(content) as OAuthCredentials;

      if (!creds.refresh || !creds.access) {
        throw new Error("Credential store missing refresh or access token");
      }

      const now = env.clock.now();
      if (now >= creds.expires) {
        const refreshed = await refreshAnthropicToken(creds.refresh, env);
        await env.fs.mkdir(env.path.dirname(credentialStorePath), { recursive: true });
        await env.fs.writeFile(
          credentialStorePath,
          JSON.stringify(refreshed, null, 2),
          "utf-8"
        );
        return refreshed.access;
      }

      return creds.access;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Claude OAuth provider selected but no session token found. " +
            "Set config.provider.sessionToken, ANTHROPIC_OAUTH_TOKEN env, or create credential store at " +
            credentialStorePath
        );
      }
      throw err;
    }
  }

  throw new Error(
    "Claude OAuth provider selected but no session token found. " +
      "Set config.provider.sessionToken, ANTHROPIC_OAUTH_TOKEN env, or config.provider.credentialStorePath"
  );
}
