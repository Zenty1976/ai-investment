---
name: OpenAI Usage Tracking Architecture
description: How per-call token/cost tracking is implemented and where usage flows
---

## Rule
Every OpenAI call is tracked automatically inside `callAi` and `callAiWithWebSearch` in `ai-service.ts`. Routes pass `module`, `operation`, and `retryNumber` via `AiServiceOptions`. Skipped AI calls (fingerprint unchanged) are tracked separately via `trackSkipped()`.

**Why:** Retries must appear as separate records (spec requirement). Skips are not API calls but must be counted as "savings". These two streams are aggregated separately in `getStats()`.

## How to apply
- When adding a new route that calls `callAi`/`callAiWithWebSearch`, always pass `module: "module-name"` in options.
- Pass `retryNumber: attempt` in retry loops so each attempt is recorded as a distinct record.
- Call `trackSkipped(moduleId)` wherever an AI call is bypassed without going to OpenAI.
- The `data/openai-usage-log.json` file is written by `initUsageLog()` (called at server startup) and updated via debounced `setImmediate` writes.
- Frontend hook: `useOpenAIUsageStats(window)` from `@workspace/api-client-react`; endpoint is `GET /api/openai-usage/stats?window=today|24h|7d|30d`.

## Pricing config
`MODEL_PRICING` in `openai-usage-service.ts` — update here when OpenAI changes rates. All derived costs are labeled "Estimated" in the UI.
