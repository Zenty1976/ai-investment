---
name: Central Model Routing
description: How all OpenAI model selection works — config file, categories, module overrides, pricing module, and which modules use which model.
---

## Architecture

All model selection goes through `src/lib/ai-model-config.ts` → `getModel(category, module?)`.
All pricing lives in `src/lib/ai-model-pricing.ts` (logger-free; safe to import from tests).
`openai-usage-service.ts` re-exports from `ai-model-pricing.ts`.

## Resolution order

1. `MODULE_OVERRIDES[module]` if present
2. `AI_MODEL_CONFIG[category].model`

## Current model mapping (gpt-4.1 family migration)

| Category | Model | Modules |
|----------|-------|---------|
| discovery | gpt-4o-mini | company-monitor-discovery, investor-watch-discovery |
| monitor | gpt-4.1-mini | market-monitor, news-monitor, event-monitor, sector-monitor, investor-watch |
| analysis | gpt-4.1-mini | risk-analyzer, portfolio-analyzer, portfolio-target-synthesiser |
| decision | gpt-4.1 | trade-decision-engine |
| brief | gpt-4o-mini | command-brief |
| repair | gpt-4o-mini | retry paths |

MODULE_OVERRIDES (win over category):
- `company-monitor` → gpt-4.1 (core intelligence, conservative)
- `opportunity-finder` → gpt-4.1 (cross-module reasoning, not simple ranking)

## API compatibility

Two APIs in use:
- `callAi` → Chat Completions (portfolio-target-synthesiser)
- `callAiWithWebSearch` → Responses API with web_search_preview (everything else with web search)

Both gpt-4.1 and gpt-4.1-mini are compatible with both APIs.
No `reasoning_effort` parameter — that is o-series only. Temperature controls diversity.

## Reasoning tokens

Field added to `OpenAIUsageRecord.reasoningTokens`. Extracted from:
- Chat Completions: `completion_tokens_details.reasoning_tokens`
- Responses API: `output_tokens_details.reasoning_tokens`
Will be 0 for gpt-4.1 family; non-zero for o-series future migration.

## Test file

`src/lib/__tests__/ai-model-config.test.ts` — 58 tests covering:
- Category defaults, module overrides, override precedence
- MODEL_PRICING completeness (every active model must have a pricing entry)
- estimateCostUsd arithmetic (cached tokens, reasoning tokens)
- Request construction shapes (Responses API vs Chat Completions parameter differences)
- Usage token parsing (both API response formats)
- No-fallback safety checks

Imports from `ai-model-pricing.ts` (not usage service) to avoid pino/logger in test runner.

## gpt-4.1-nano

Not yet in the pricing table (not verified available). Discovery and repair stay on gpt-4o-mini.
When confirmed: add to MODEL_PRICING and update `discovery` and `repair` category defaults.

**Why:** o-series reasoning_effort is not applicable to gpt-4.1 family. The AI service uses
temperature throughout — do not add reasoning_effort unless switching to o-series.
