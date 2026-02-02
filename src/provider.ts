/**
 * provider.ts — LLM provider interface.
 *
 * Minimal provider implementation for wiring in main.ts.
 */

/** Anthropic provider. */
export interface AnthropicProvider {
  name: string;
  apiKey: string;
}

/**
 * Create an Anthropic provider.
 *
 * @param apiKey - Anthropic API key.
 * @returns Provider instance.
 */
export function createAnthropicProvider(apiKey: string): AnthropicProvider {
  return {
    name: "anthropic",
    apiKey,
  };
}
