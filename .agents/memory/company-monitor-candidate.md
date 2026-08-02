---
name: CompanyMonitorCandidate shape for companyIdentityStore.resolve
description: resolve() expects {key: string, result: Record<string,unknown>} objects, not bare result objects. Passing e.result directly causes c.key.startsWith() to throw.
---

## Rule
When calling `companyIdentityStore.resolve(symbol, opts, candidates)`, the `candidates` array must be `CompanyMonitorCandidate[]` with shape `{ key: string, result: Record<string, unknown> }`.

Correct pattern (matching portfolio-analyzer.ts):
```typescript
const candidates = analysisRepository.getAll()
  .filter((e) => e.moduleName.startsWith("company-monitor:"))
  .map((e) => ({ key: e.moduleName, result: e.result as Record<string, unknown> }));
```

Or if you already have a `companyEntries` array extracted from the repo:
```typescript
companyEntries.map((e) => ({ key: `company-monitor:${e.ticker}`, result: e.result }))
```

**Why:** `resolve()` calls `c.key.startsWith("company-monitor:")` on every candidate (line 193 of company-identity.ts). If candidates are bare result objects (no `key` field), `c.key` is `undefined` and `.startsWith()` throws `TypeError: Cannot read properties of undefined`.

**How to apply:** Any route that passes company monitor entries to `resolve()` must include the `key` field. The `key` must be the full `moduleName` string (e.g. `"company-monitor:MSFT"`).
