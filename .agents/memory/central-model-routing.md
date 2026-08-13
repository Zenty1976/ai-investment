---
name: Central Model Routing
description: All AI callers now use getModel(category, module) from lib/ai-model-config.ts; MODULE_OVERRIDES for per-module overrides; zod must be in api-server direct deps.
---

All 14 OpenAI call sites in the API server now use `getModel(category, moduleName)` from
`lib/ai-model-config.ts` instead of hardcoded model strings.

## Category → Module mapping (never change without updating both)

| Module | Category | Resolved model |
|---|---|---|
| market-monitor | monitor | gpt-4o |
| news-monitor | monitor | gpt-4o |
| event-monitor | monitor | gpt-4o |
| sector-monitor | monitor | gpt-4o |
| company-monitor (full) | monitor | gpt-4o |
| opportunity-finder | monitor | gpt-4o |
| investor-watch (full) | monitor | gpt-4o |
| risk-analyzer | analysis | gpt-4o |
| portfolio-analyzer | analysis | gpt-4o |
| portfolio-target-synthesiser | analysis | gpt-4o |
| trade-decision-engine | decision | gpt-4o |
| command-brief | brief | gpt-4o-mini |
| company-monitor (discovery) | discovery | gpt-4o-mini |
| investor-watch (discovery) | discovery | gpt-4o-mini |

## To swap model for one module only
Add to `MODULE_OVERRIDES` in `lib/ai-model-config.ts`:
```typescript
"market-monitor": "gpt-4.1",
```

## Infrastructure notes
- zod must be in api-server/package.json `"dependencies"` as `"zod": "catalog:"`
  (the normalizer imports it directly; api-zod is a peer dep, not transitive enough)
- After any package.json change, make sure vitest is NOT in devDependencies
  (blocked by Replit package firewall; causes pnpm install to fail completely)
- `portfolio-target-synthesiser.ts` now also sets `module: "portfolio-target-synthesiser"` in
  its callAi options (was previously "unknown" in usage tracking)

**Why:** Centralised routing means a single-line change in ai-model-config.ts can swap models
for an entire category (or a single module via MODULE_OVERRIDES), without hunting through 14+ files.
