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
 * Returns the configured model string for the given category.
 * Use this in every route instead of hardcoding "gpt-4o".
 */
export function getModel(category: AiModelCategory): string {
  return AI_MODEL_CONFIG[category].model;
}
