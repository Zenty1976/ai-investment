/**
 * Centralized OpenAI Model Pricing
 *
 * Pure data + pure math — no logger, no I/O, safe to import from tests.
 *
 * Imported by openai-usage-service.ts (runtime) and test files (test runner).
 *
 * Source: openai.com/pricing — update here when rates change.
 * All entries are USD per 1 million tokens.
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
  /** USD per 1M cached input tokens (prompt cache hit). Defaults to inputPer1M if absent. */
  cachedInputPer1M?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Legacy gpt-4o family (still in use for discovery/brief/repair) ─────────
  "gpt-4o":                    { inputPer1M: 2.50,  outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini":               { inputPer1M: 0.15,  outputPer1M: 0.60,  cachedInputPer1M: 0.075 },
  "gpt-4o-2024-08-06":         { inputPer1M: 2.50,  outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini-2024-07-18":    { inputPer1M: 0.15,  outputPer1M: 0.60,  cachedInputPer1M: 0.075 },
  // ── gpt-4.1 family (active: monitor, analysis, decision, company, OF, discovery) ──
  "gpt-4.1":                   { inputPer1M: 2.00,  outputPer1M: 8.00,  cachedInputPer1M: 0.50 },
  "gpt-4.1-mini":              { inputPer1M: 0.40,  outputPer1M: 1.60,  cachedInputPer1M: 0.10 },
  "gpt-4.1-nano":              { inputPer1M: 0.10,  outputPer1M: 0.40,  cachedInputPer1M: 0.025 },
};

/**
 * Estimate cost in USD for a single API call. Returns null if model pricing is unknown.
 *
 * @param reasoningTokens  Tokens consumed by internal model reasoning (o-series models).
 *   For gpt-4.1 family these are 0; tracked for future o-series compatibility.
 *   Reasoning tokens are billed at the output token rate (conservative estimate).
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  reasoningTokens = 0
): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const uncachedInput = Math.max(0, promptTokens - cachedTokens);
  const cachedCost    = (cachedTokens     / 1_000_000) * (p.cachedInputPer1M ?? p.inputPer1M);
  const inputCost     = (uncachedInput    / 1_000_000) * p.inputPer1M;
  // Reasoning tokens are output tokens; visible output tokens already include them
  // in the completion_tokens count for non-o-series models, so only add separately
  // when the API reports them as a distinct field (o-series).
  const outputCost    = (completionTokens / 1_000_000) * p.outputPer1M;
  const reasoningCost = (reasoningTokens  / 1_000_000) * p.outputPer1M;
  return inputCost + cachedCost + outputCost + reasoningCost;
}
