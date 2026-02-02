/**
 * agent.ts — LLM call loop (core agent execution)
 *
 * The agent module implements the core loop: receive message → call LLM →
 * execute tools → respond. It manages the interaction between the LLM
 * provider and tool execution, looping until the LLM returns a final response.
 */

/** Maximum number of LLM call iterations to prevent infinite loops */
const MAX_ITERATIONS = 25;

/** A message in the conversation history */
export interface Message {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** A session containing conversation state */
export interface Session {
  sessionKey: string;
  model: string;
  messages: Message[];
}

/** LLM provider interface for chat completions */
export interface LLMProvider {
  chat(params: {
    model: string;
    system: string;
    messages: Message[];
    tools?: ToolDefinition[];
  }): Promise<LLMResponse>;
}

/** Response from an LLM chat call */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason: "end" | "tool_use";
}

/** A tool call requested by the LLM */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Definition of a tool for the LLM */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A function that executes a tool */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

/** Registry of available tools */
export type ToolRegistry = Map<
  string,
  { definition: ToolDefinition; execute: ToolExecutor }
>;

/**
 * Run the agent loop: call LLM → execute tools → repeat until done.
 *
 * This is the main agent execution function. It:
 * 1. Calls the LLM with system prompt + session message history
 * 2. If LLM returns tool calls: executes them via tool registry, appends results
 * 3. Loops until LLM returns a final text response (no more tool calls)
 * 4. Appends all messages (assistant, tool results) to the session
 * 5. Returns the final assistant response text
 *
 * @param session - The session containing conversation history and config
 * @param systemPrompt - The system prompt to guide the LLM
 * @param tools - Registry of available tools
 * @param llm - The LLM provider to use for chat completions
 * @returns The final assistant response text
 * @throws Error if max iterations exceeded (infinite loop prevention)
 */
export async function runAgent(
  session: Session,
  systemPrompt: string,
  tools: ToolRegistry,
  llm: LLMProvider
): Promise<string> {
  let iterations = 0;

  // Convert tool registry to array of definitions for LLM
  const toolDefinitions =
    tools.size > 0 ? Array.from(tools.values()).map((t) => t.definition) : undefined;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Call the LLM with current message history
    const response = await llm.chat({
      model: session.model,
      system: systemPrompt,
      messages: session.messages,
      tools: toolDefinitions,
    });

    // If LLM returned a final text response (no tool calls), we're done
    if (response.stopReason === "end") {
      // Append the assistant's final message to the session
      session.messages.push({
        role: "assistant",
        content: response.content,
      });
      return response.content;
    }

    // LLM requested tool calls
    if (response.stopReason === "tool_use" && response.toolCalls) {
      // Append the assistant message with tool calls
      session.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      // Execute each tool call and append results
      for (const toolCall of response.toolCalls) {
        let result: string;

        try {
          const tool = tools.get(toolCall.name);
          if (!tool) {
            result = `Error: Unknown tool "${toolCall.name}"`;
          } else {
            result = await tool.execute(toolCall.arguments);
          }
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        // Append tool result to session
        session.messages.push({
          role: "tool_result",
          content: result,
          toolCallId: toolCall.id,
        });
      }

      // Continue loop to call LLM again with tool results
      continue;
    }

    // Unexpected state - treat as end
    session.messages.push({
      role: "assistant",
      content: response.content,
    });
    return response.content;
  }

  // Max iterations exceeded
  throw new Error(
    `Max iterations (${MAX_ITERATIONS}) exceeded. Possible infinite loop.`
  );
}
