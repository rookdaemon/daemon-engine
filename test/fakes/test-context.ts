import type { ToolContext } from "../../src/agent.js";
import { createNodeEnvironment } from "../../src/env/environment.js";
import type { Environment } from "../../src/env/environment.js";

/**
 * Create a minimal ToolContext for testing.
 *
 * @param workspace - Absolute path to the workspace directory
 * @param env - Optional environment override (defaults to createNodeEnvironment())
 * @returns A valid ToolContext object for testing
 */
export function createTestContext(
  workspace: string,
  env?: Environment
): ToolContext {
  return {
    workspace,
    env: env ?? createNodeEnvironment(),
    sessionKey: "test-session",
  };
}
