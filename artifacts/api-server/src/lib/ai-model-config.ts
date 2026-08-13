/**
 * Centralized AI Model Configuration
 *
 * All model selections must go through this file.
 * Changing a category here updates every module that uses it.
 *
 * Categories:
 *   discovery — lightweight pre-screening / change-detection (cheap)
 *   monitor   — web-search-backed external observation (market, news, company)
 *   analysis  — synthesis over existing data (portfolio, risk)
 *   decision  — trade decision engine
 *   brief     — highly structured, compact output from pre-analyzed data
 *   repair    — schema validation retry attempts
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
  discovery: {
    model: "gpt-4o-mini",
    description: "Lightweight change-detection and pre-screening",
  },
  monitor: {
    model: "gpt-4o",
    description: "Web-search-backed external observation",
  },
  analysis: {
    model: "gpt-4o",
    description: "Synthesis over already-collected data",
  },
  decision: {
    model: "gpt-4o",
    description: "Trade decision engine — requires highest quality",
  },
  brief: {
    model: "gpt-4o-mini",
    description: "Highly structured output from pre-analyzed inputs",
  },
  repair: {
    model: "gpt-4o-mini",
    description: "Schema-validation repair retries",
  },
};

/**
 * Optional per-module model overrides.
 *
 * When a module's identifier is present here, its model takes precedence over
 * the category default in AI_MODEL_CONFIG. This is the ONE place to swap the
 * model for a specific module without affecting the rest of its category.
 *
 * Keys must match the `module` string used in AI call options
 * (e.g. "market-monitor", "company-monitor", "trade-decision-engine").
 *
 * Example — to test gpt-4.1 for market-monitor only:
 *   "market-monitor": "gpt-4.1",
 */
export const MODULE_OVERRIDES: Record<string, string> = {
  // "market-monitor": "gpt-4.1",
};

/**
 * Returns the resolved model string for a given category and optional module.
 *
 * Resolution order (first match wins):
 *   1. Per-module override in MODULE_OVERRIDES  (if `module` is provided and present)
 *   2. Category default in AI_MODEL_CONFIG
 *
 * The returned string is always a concrete model identifier (e.g. "gpt-4o")
 * suitable for passing directly to the OpenAI API.  Usage tracking records the
 * actual resolved model — never only the category name.
 */
export function getModel(category: AiModelCategory, module?: string): string {
  if (module !== undefined && Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, module)) {
    return MODULE_OVERRIDES[module];
  }
  return AI_MODEL_CONFIG[category].model;
}
