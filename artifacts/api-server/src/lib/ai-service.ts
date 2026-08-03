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
  /**
   * When true, instructs the Responses API to emit only a valid JSON object
   * (no surrounding prose, no markdown).  Equivalent to `json_object` mode
   * in Chat Completions.
   */
  jsonMode?: boolean;
}

// ── Debug metadata ────────────────────────────────────────────────────────────

/** Debug metadata returned alongside every AI call result. */
export interface AiDebugInfo {
  /** The full request payload sent to the API */
  request: Record<string, unknown>;
  /** Raw text string returned by the model — absent on timeout or network failure */
  rawResponse: string;
  /** Token usage reported by the API */
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
  };
  /** ISO 8601 timestamp of when the call was initiated */
  calledAt: string;
  /** Whether a web search tool was used during this call */
  webSearchUsed: boolean;
  /** Present only when web-search detection failed — explains what was seen */
  webSearchDetection?: {
    outputItemTypes: string[];
    webSearchCallFound: boolean;
    citationAnnotationCount: number;
    extractedSourceCount: number;
  };
  /**
   * Which stage of the pipeline failed, when the debug was captured from an error.
   * Values: request | timeout | response | web-search-validation | json-parse
   */
  errorStage?: string;
}

/**
 * Extract whatever debug context is available from an error thrown by
 * `callAiWithWebSearch`.  Returns null when the error carries no AI context.
 * Safe to call on any caught value.
 */
export function extractAiErrorDebug(err: unknown): Partial<AiDebugInfo> | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  // Only errors enriched by callAiWithWebSearch carry these private fields
  if (!e._requestPayload && !e._rawResponse && !e._webSearchDebug && !e._errorStage) return null;
  return {
    request: (e._requestPayload ?? {}) as Record<string, unknown>,
    rawResponse: typeof e._rawResponse === "string" ? e._rawResponse : "",
    webSearchUsed: false,
    calledAt: typeof e._calledAt === "string" ? e._calledAt : new Date().toISOString(),
    usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
    webSearchDetection: e._webSearchDebug as AiDebugInfo["webSearchDetection"],
    errorStage: typeof e._errorStage === "string" ? e._errorStage : undefined,
  };
}

export interface AiCallResult<T> {
  result: T;
  debug: AiDebugInfo;
}

// ── Web-search result ─────────────────────────────────────────────────────────

export interface WebSearchSource {
  title: string;
  url: string;
}

export interface WebSearchAiCallResult<T> extends AiCallResult<T> {
  sources: WebSearchSource[];
}

// ── Standard chat completions (no web search) ─────────────────────────────────

/**
 * Call OpenAI via Chat Completions and return parsed JSON + debug metadata.
 * The model must return valid JSON; enforce with response_format json_object.
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

  logger.debug({ model }, "Calling OpenAI (chat completions)");

  const response = await client.chat.completions.create(requestPayload);

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned an empty response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  return {
    result: parsed as T,
    debug: {
      request: requestPayload as unknown as Record<string, unknown>,
      rawResponse: raw,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? null,
        completion_tokens: response.usage?.completion_tokens ?? null,
        total_tokens: response.usage?.total_tokens ?? null,
      },
      calledAt,
      webSearchUsed: false,
    },
  };
}

// ── Responses API with web search ─────────────────────────────────────────────

/** Per-attempt timeout — aborts the OpenAI request after this many milliseconds. */
const WEB_SEARCH_TIMEOUT_MS = 90_000;

/**
 * Call OpenAI via the Responses API with web_search_preview enabled.
 *
 * IMPORTANT: This function throws a clear error if web search was not actually
 * performed. Callers can never silently receive a response generated from
 * model memory when live data was expected.
 *
 * Every error thrown after the request payload is built carries these private fields
 * so callers can surface debug information even on timeout / network failures:
 *   _requestPayload, _calledAt, _rawResponse, _errorStage, _webSearchDebug?
 *
 * The model is instructed to return a JSON object only. The server is
 * responsible for setting any timestamp fields — do NOT ask the model to
 * generate timestamps.
 */
export async function callAiWithWebSearch<T>(
  systemPrompt: string,
  userPrompt: string,
  options: AiServiceOptions = {}
): Promise<WebSearchAiCallResult<T>> {
  const { model = "gpt-4o-mini", maxTokens = 1200, temperature = 0.3, jsonMode = false } = options;
  const client = getClient();
  const calledAt = new Date().toISOString();

  // Build the request payload BEFORE the network call so it is always
  // available for debug output even if the call times out or errors.
  const requestPayload: Record<string, unknown> = {
    model,
    max_output_tokens: maxTokens,
    temperature,
    tools: [{ type: "web_search", search_context_size: "high" }],
    // "required" forces the model to invoke at least one tool before answering.
    // Because web_search is the only configured tool this guarantees a web-search
    // call on every attempt rather than relying on prompt instructions alone.
    tool_choice: "required",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // When jsonMode is true, instruct the Responses API to emit only a valid
    // JSON object — prevents the model from wrapping the response in prose.
    ...(jsonMode ? { text: { format: { type: "json_object" } } } : {}),
  };

  // ── Error helper ─────────────────────────────────────────────────────────
  // Attaches debug context to every error thrown from this function.
  // Typed as `never` so TypeScript knows the function always throws.
  function fail(
    stage: string,
    message: string,
    rawResponse = "",
    extra?: Record<string, unknown>
  ): never {
    throw Object.assign(new Error(message), {
      _requestPayload: requestPayload,
      _calledAt: calledAt,
      _rawResponse: rawResponse,
      _errorStage: stage,
      ...extra,
    });
  }

  logger.debug({ model }, "Calling OpenAI (Responses API + web search)");

  // ── AbortController — enforce per-attempt timeout ─────────────────────
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    WEB_SEARCH_TIMEOUT_MS
  );

  let response: Awaited<ReturnType<typeof client.responses.create>>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response = await client.responses.create(requestPayload as any, {
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);
  } catch (err) {
    clearTimeout(timeoutHandle);
    const isAbort = controller.signal.aborted;
    fail(
      isAbort ? "timeout" : "request",
      isAbort
        ? `OpenAI request timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000} seconds`
        : `OpenAI API error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Extract text content and URL citation annotations ──────────────────
  // Do this before the web-search validation so we can report counts in the
  // error debug payload and in the returned debug info.
  let rawText = "";
  const sources: WebSearchSource[] = [];
  let citationAnnotationCount = 0;

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          rawText += part.text;
          for (const ann of part.annotations) {
            if (ann.type === "url_citation") {
              citationAnnotationCount++;
              // Deduplicate by URL
              if (!sources.find((s) => s.url === ann.url)) {
                sources.push({ title: ann.title, url: ann.url });
              }
            }
          }
        }
      }
    }
  }

  // ── Robust web-search detection ────────────────────────────────────────
  // Accept web search as successfully performed when at least one of:
  //   1. response.output contains an item with type "web_search_call"
  //   2. a returned message contains URL citations or web annotations
  //   3. the extracted sources list contains at least one valid web source
  const outputItemTypes = response.output.map((item) => item.type);
  const hasWebSearchCall = outputItemTypes.includes("web_search_call");
  const hasCitations = citationAnnotationCount > 0;
  const hasSources = sources.length > 0;
  const webSearchUsed = hasWebSearchCall || hasCitations || hasSources;

  const debugPayload = {
    outputItemTypes,
    webSearchCallFound: hasWebSearchCall,
    citationAnnotationCount,
    extractedSourceCount: sources.length,
  };

  if (!webSearchUsed) {
    logger.warn(
      { ...debugPayload, model },
      "Web search not detected in OpenAI response"
    );
    fail("web-search-validation", "Web search was not detected in the OpenAI response.", rawText, {
      _webSearchDebug: debugPayload,
    });
  }

  if (!rawText) {
    fail("response", "OpenAI Responses API returned no text content");
  }

  // ── Parse JSON — strip markdown fences, then extract first {...} object ──
  // Strategy (in order):
  // 1. Strip markdown fences (```json ... ```)
  // 2. Direct JSON.parse on the trimmed text
  // 3. Extract the first complete top-level {...} object — handles cases where
  //    the model prefixes the JSON with prose ("Here is the corrected JSON:")
  // 4. Fail with a clear error including the first 400 chars of raw output
  let jsonStr = rawText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback: find the first { … } that parses as an object
    const braceStart = jsonStr.indexOf("{");
    const braceEnd = jsonStr.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      const candidate = jsonStr.slice(braceStart, braceEnd + 1);
      try {
        parsed = JSON.parse(candidate);
        logger.warn({ model }, "JSON extracted from surrounding prose — model did not return bare JSON");
      } catch {
        // fall through to hard fail
      }
    }
    if (parsed === undefined) {
      fail(
        "json-parse",
        `OpenAI returned invalid JSON after web search: ${rawText.slice(0, 400)}`,
        rawText
      );
    }
  }

  const debug: AiDebugInfo = {
    request: requestPayload as unknown as Record<string, unknown>,
    rawResponse: rawText,
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? null,
      completion_tokens: response.usage?.output_tokens ?? null,
      total_tokens: response.usage?.total_tokens ?? null,
    },
    calledAt,
    webSearchUsed,
  };

  return { result: parsed as T, debug, sources };
}
