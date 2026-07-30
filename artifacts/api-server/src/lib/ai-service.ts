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

/**
 * Send a prompt to OpenAI and return parsed JSON.
 * All modules should use this method and never call OpenAI directly.
 */
export async function callAi<T>(
  systemPrompt: string,
  userPrompt: string,
  options: AiServiceOptions = {}
): Promise<T> {
  const { model = "gpt-4o-mini", maxTokens = 512, temperature = 0.3 } = options;

  const client = getClient();

  logger.debug({ model }, "Calling OpenAI");

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

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

  return parsed as T;
}
