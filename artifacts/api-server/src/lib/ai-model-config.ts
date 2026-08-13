/**
 * Centralized AI Model Configuration
 *
 * All model selections must go through this file.
 * Changing a category here updates every module that uses it.
 *
 * Design principle: "Spend little on routine intelligence and spend
 * intelligently on the few decisions where model quality matters."
 *
 * Categories:
 *   discovery — lightweight pre-screening / change-detection (cheap)
 *   monitor   — qualitative upstream analysis (market, news, sector)
 *   analysis  — synthesis over existing data (portfolio, risk)
 *   decision  — trade decision engine (quality priority)
 *   brief     — compact structured output from pre-analyzed inputs (cheap)
 *   repair    — schema-validation retry attempts (cheap)
 *
 * Model classes used (gpt-4.1 family — verified in MODEL_PRICING):
 *   gpt-4.1        — strong reasoning / core intelligence modules
 *   gpt-4.1-mini   — mid qualitative / high-volume upstream monitors
 *   gpt-4o-mini    — cheap / discovery / repair
 *
 * Note: gpt-4.1-nano is not yet in the verified pricing table.
 * When confirmed available, update discovery and repair to gpt-4.1-nano.
 *
 * Web-search compatibility:
 *   gpt-4.1 and gpt-4.1-mini: compatible with Responses API + web_search_preview ✓
 *   gpt-4o-mini: compatible with Responses API + web_search_preview ✓
 *   All models: no reasoning_effort parameter (that is an o-series concept).
 *   Temperature continues to control output diversity.
 *
 * Reasoning tokens:
 *   gpt-4.1 family does not expose separate reasoning_tokens in usage.
 *   The field is tracked but will be 0 for these models.
 *   Switch to o-series (o3, o4-mini) to get explicit reasoning token tracking.
 */

export type AiModelCategory =
  | "discovery"
  | "monitor"
  | "analysis"
  | "decision"
  | "brief"
  | "repair";

export const AI_MODEL_CONFIG: Record<
  AiModelCategory,
  { model: string; description: string }
> = {
  /**
   * discovery — lightweight change-detection and pre-screening.
   * Used by: company-monitor-discovery, investor-watch-discovery.
   * Responsibility: "Has anything materially changed that justifies an expensive full analysis?"
   * Quality bar: structured extraction, materiality classification, relevance screening.
   * gpt-4.1-nano is sufficient — output is a binary signal, not investment reasoning.
   * Pricing verified: $0.10/1M input, $0.025/1M cached, $0.40/1M output.
   */
  discovery: {
    model: "gpt-4.1-nano",
    description: "Lightweight change-detection and pre-screening",
  },

  /**
   * monitor — qualitative upstream intelligence.
   * Used by: market-monitor, news-monitor, event-monitor (discovery path),
   *          sector-monitor (discovery path), investor-watch (full).
   * Responsibility: web-search-backed interpretation of market conditions.
   * gpt-4.1-mini is 84% cheaper input cost than gpt-4o and capable of
   * cross-asset reasoning, macro interpretation, and structured web-search output.
   */
  monitor: {
    model: "gpt-4.1-mini",
    description: "Web-search-backed external observation and qualitative interpretation",
  },

  /**
   * analysis — synthesis over already-collected intelligence.
   * Used by: risk-analyzer, portfolio-analyzer, portfolio-target-synthesiser.
   * Responsibility: AI qualitative interpretation of deterministic facts.
   * gpt-4.1-mini handles structured synthesis well; frontier model not required.
   */
  analysis: {
    model: "gpt-4.1-mini",
    description: "Qualitative synthesis over pre-computed deterministic facts",
  },

  /**
   * decision — trade decision engine.
   * Used by: trade-decision-engine.
   * Responsibility: central buy/sell/hold decision combining all upstream intelligence.
   * Quality priority — gpt-4.1 for maximum reasoning quality on consequential decisions.
   * Spend is acceptable here because hybrid architectures have reduced call frequency.
   */
  decision: {
    model: "gpt-4.1",
    description: "Trade decision engine — quality priority, full reasoning model",
  },

  /**
   * brief — compact structured output from pre-analyzed inputs.
   * Used by: command-brief.
   * Responsibility: 20-second executive summary; all intelligence already produced.
   * gpt-4o-mini is adequate; brief must still provide useful interpretation not
   * mechanical concatenation, but the input is fully structured.
   */
  brief: {
    model: "gpt-4o-mini",
    description: "Compact structured executive summary from pre-analyzed inputs",
  },

  /**
   * repair — schema-validation retry attempts.
   *
   * NOTE: This category is currently NOT called by any route. All retry loops reuse
   * the same getModel() call as their first attempt (same category, incremented
   * retryNumber). The category exists for future use if a dedicated cheaper repair
   * pass is introduced.
   *
   * Left on gpt-4o-mini rather than nano because retry prompts embed the original
   * AI response + schema error context — semantic investment content is present.
   * A nano model could misinterpret that content and corrupt the repair attempt.
   */
  repair: {
    model: "gpt-4o-mini",
    description: "Schema-validation repair retries — mechanical, no investment reinterpretation",
  },
};

/**
 * Per-module model overrides.
 *
 * Modules listed here use their specific model regardless of category.
 * This is the ONE place to deviate from the category default.
 *
 * Keys must match the `module` string passed in AI call options.
 *
 * Modules on gpt-4.1 (strong):
 *   company-monitor    — core intelligence: thesis, investmentCaseStrength, bull/base/bear,
 *                        thesis invalidation. Fewer high-quality calls > many cheap weak ones.
 *   opportunity-finder — cross-module investment reasoning across multiple companies;
 *                        consequential ranking that feeds Portfolio and TDE context.
 *
 * Modules NOT overridden (using category default):
 *   trade-decision-engine uses category `decision` which is already gpt-4.1.
 */
export const MODULE_OVERRIDES: Record<string, string> = {
  /**
   * Company Monitor full analysis — gpt-4.1.
   * Category: monitor (would be gpt-4.1-mini without override).
   * Rationale: Investment thesis, investment view, thesis strengthening/weakening/invalidation,
   * competitive position, bull/base/bear cases. This is core intelligence that downstream
   * modules (TDE, Portfolio V2, Risk, Opportunity Finder) all depend on. The architecture
   * already reduces call frequency through discovery gating — fewer, higher-quality calls.
   */
  "company-monitor": "gpt-4.1",

  /**
   * Opportunity Finder — gpt-4.1.
   * Category: monitor (would be gpt-4.1-mini without override).
   * Rationale: Performs substantial cross-module reasoning across multiple companies,
   * sector contexts, portfolio constraints, price contexts, and risk assessments.
   * Not merely ranking a pre-filtered list — synthesizes conviction scores with investment theses.
   * Kept on gpt-4.1 to preserve output quality that feeds TDE and Portfolio V2.
   */
  "opportunity-finder": "gpt-4.1",
};

/**
 * Returns the resolved model string for a given category and optional module.
 *
 * Resolution order (first match wins):
 *   1. Per-module override in MODULE_OVERRIDES  (if `module` is provided and present)
 *   2. Category default in AI_MODEL_CONFIG
 *
 * The returned string is always a concrete model identifier suitable for passing
 * directly to the OpenAI API. Usage tracking records the actual resolved model.
 */
export function getModel(category: AiModelCategory, module?: string): string {
  if (module !== undefined && Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, module)) {
    return MODULE_OVERRIDES[module];
  }
  return AI_MODEL_CONFIG[category].model;
}
