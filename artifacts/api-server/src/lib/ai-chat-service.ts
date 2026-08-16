/**
 * AI Chat Service — Isolated OpenAI Responses API client
 *
 * IMPORTANT: This file is completely isolated from ai-service.ts.
 * It does NOT share state, clients, or infrastructure with existing modules.
 * Existing modules are unaffected by this file.
 *
 * Uses:
 *   - OpenAI Responses API (client.responses.create)
 *   - previous_response_id for persistent conversation state (no Assistants/Threads)
 *   - store: true so OpenAI retains server-side conversation history
 *   - Read-only function tools from ai-chat-tools.ts
 *   - web_search_preview for external information
 */

import OpenAI from "openai";
import { AI_CHAT_TOOL_DEFINITIONS, executeToolCall } from "./ai-chat-tools.js";

// ── Isolated OpenAI client — never shared with ai-service.ts ─────────────────

let _chatClient: OpenAI | null = null;

function getChatClient(): OpenAI {
  if (!_chatClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _chatClient = new OpenAI({ apiKey });
  }
  return _chatClient;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHAT_MODEL = "gpt-4.1-mini";
const MAX_TOOL_ITERATIONS = 5;   // safety cap on tool-call loop
const TIMEOUT_MS = 60_000;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the conversational analyst for the AI Investment application — an automated investment monitoring and decision-support system.

You can:
- Explain what the system currently says about any company, module, or situation
- Retrieve current stored results from the investment modules using read-only tools
- Search the web for current external information when relevant
- Discuss investment evidence, catalyst setups, and market context naturally

You cannot:
- Execute trades or create orders
- Approve Trade Reviews
- Modify any module result or system state
- Trigger analysis runs or module updates
- Replace the system's formal decision modules

IMPORTANT RULES:
1. Use read-only tools to retrieve CURRENT application state when the user asks about the current situation — do not rely only on conversation memory for current facts.
2. Distinguish clearly between what OUR SYSTEM SAYS (from tools) and CURRENT EXTERNAL INFORMATION (from web search).
3. Trade Decision is authoritative for decision state. Trade Review is authoritative for actionability. Never claim a trade is actionable unless Trade Review supports that.
4. When discussing WaitForEvent situations: make clear the company may look interesting but the system is waiting for the specific event before reassessing.
5. Answer naturally and conversationally. Do not dump raw JSON at the user.
6. If current internal data is unavailable, say so — do not invent it.
7. You are an analyst and explanation interface. Do not become an independent replacement for the system's formal modules.`;

// ── Result type ───────────────────────────────────────────────────────────────

export interface AiChatTurn {
  assistantText: string;
  newResponseId: string;
  toolsUsed: string[];
  webSearchUsed: boolean;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ── Main chat function ────────────────────────────────────────────────────────

/**
 * Send a user message and return the assistant response.
 *
 * @param userText          The user's message
 * @param previousResponseId The last response ID from OpenAI (null for first message)
 * @returns AiChatTurn with assistant text, new response ID, tool usage info
 */
export async function sendChatMessage(
  userText: string,
  previousResponseId: string | null
): Promise<AiChatTurn> {
  const client = getChatClient();

  const toolsUsed: string[] = [];
  let webSearchUsed = false;
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  // ── Build tools list ──────────────────────────────────────────────────────
  const tools: unknown[] = [
    { type: "web_search_preview", search_context_size: "medium" },
    ...AI_CHAT_TOOL_DEFINITIONS,
  ];

  // ── Build initial request ─────────────────────────────────────────────────
  // First message: include system prompt + user message
  // Subsequent messages: just user message with previous_response_id
  const buildInput = (text: string, isFirst: boolean): unknown =>
    isFirst
      ? [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ]
      : [{ role: "user", content: text }];

  const isFirst = previousResponseId === null;

  const requestBase: Record<string, unknown> = {
    model: CHAT_MODEL,
    tools,
    tool_choice: "auto",
    store: true,
    max_output_tokens: 1500,
    input: buildInput(userText, isFirst),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  };

  // ── Tool-call loop ────────────────────────────────────────────────────────
  let currentResponseId = previousResponseId;
  let currentInput: unknown = requestBase.input;
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Awaited<ReturnType<typeof client.responses.create>>;
    try {
      const req: Record<string, unknown> = {
        model: CHAT_MODEL,
        tools,
        tool_choice: "auto",
        store: true,
        max_output_tokens: 1500,
        input: currentInput,
        ...(currentResponseId ? { previous_response_id: currentResponseId } : {}),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response = await client.responses.create(req as any, { signal: controller.signal });
      clearTimeout(timeoutHandle);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isAbort = controller.signal.aborted;
      throw new Error(
        isAbort
          ? `AI Chat request timed out after ${TIMEOUT_MS / 1000}s`
          : `AI Chat OpenAI error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Track the new response ID for continuation
    currentResponseId = response.id;

    // Accumulate usage
    if (response.usage) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = response.usage as any;
      totalUsage.promptTokens    += u.input_tokens   ?? u.prompt_tokens     ?? 0;
      totalUsage.completionTokens+= u.output_tokens  ?? u.completion_tokens ?? 0;
      totalUsage.totalTokens     += u.total_tokens   ?? 0;
    }

    // Check for web search usage
    if (response.output.some((item) => item.type === "web_search_call")) {
      webSearchUsed = true;
    }

    // Collect any function calls in the output
    const functionCalls = response.output.filter((item) => item.type === "function_call");

    // If no function calls → extract text and return
    if (functionCalls.length === 0) {
      const assistantText = extractText(response.output);
      return {
        assistantText: assistantText || "(No response text)",
        newResponseId: currentResponseId,
        toolsUsed,
        webSearchUsed,
        usage: totalUsage,
      };
    }

    // Execute all function calls
    const toolResults: unknown[] = [];
    for (const call of functionCalls) {
      if (call.type !== "function_call") continue;
      const fnName = call.name;
      let fnArgs: Record<string, unknown> = {};
      try {
        fnArgs = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        fnArgs = {};
      }

      toolsUsed.push(fnName);
      let toolOutput: unknown;
      try {
        toolOutput = await executeToolCall(fnName, fnArgs);
      } catch (err) {
        toolOutput = { error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      toolResults.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(toolOutput),
      });
    }

    // Submit tool results — next iteration will use previous_response_id = currentResponseId
    // and input = the tool results array
    currentInput = toolResults;
  }

  // Safety: if we exit the loop without a text response
  throw new Error("AI Chat tool-call loop exceeded safety limit without producing a response");
}

// ── Text extractor ─────────────────────────────────────────────────────────────

function extractText(output: { type: string; content?: unknown[] }[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const p = part as { type: string; text?: string };
        if (p.type === "output_text" && p.text) {
          parts.push(p.text);
        }
      }
    }
  }
  return parts.join("").trim();
}
