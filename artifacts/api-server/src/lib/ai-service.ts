/**
 * Shared AI Service
 *
 * All AI modules must communicate with OpenAI through this service.
 * Modules must never call the OpenAI API directly.
 */
import OpenAI from "openai";
import { logger } from "./logger";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export interface AiServiceOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Debug metadata returned alongside every AI call result. */
export interface AiDebugInfo {
  request: {
    model: string;
    temperature: number;
    max_tokens: number;
    response_format: { type: string };
    messages: Array<{ role: string; content: string }>;
  };
  rawResponse: string;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  };
  calledAt: string;
}

export interface AiCallResult<T> {
  result: T;
  debug: AiDebugInfo;
}

/**
 * Send a prompt to OpenAI and return parsed JSON + full debug metadata.
 * All modules should use this method and never call OpenAI directly.
 */
export async function callAi<T>(
  systemPrompt: string,
  userPrompt: string,
  options: AiServiceOptions = {}
): Promise<AiCallResult<T>> {
  const { model = "gpt-4o-mini", maxTokens = 512, temperature = 0.3 } = options;

  const client = getClient();
  const calledAt = new Date().toISOString();

  const requestPayload = {
    model,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_object" } as const,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ],
  };

  logger.debug({ model }, "Calling OpenAI");

  const response = await client.chat.completions.create(requestPayload);

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("OpenAI returned an empty response");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const debug: AiDebugInfo = {
    request: requestPayload,
    rawResponse: raw,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens ?? null,
      completion_tokens: response.usage?.completion_tokens ?? null,
      total_tokens: response.usage?.total_tokens ?? null,
    },
    calledAt,
  };

  return { result: parsed as T, debug };
}
