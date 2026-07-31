---
name: Analysis Repository
description: In-memory shared store between analysis modules; architectural rules and extension pattern.
---

## Rule
Every analysis module saves its latest result to `analysisRepository.save(moduleName, result)` immediately after successful validation. Modules never call each other directly.

## Location
`artifacts/api-server/src/lib/analysis-repository.ts` — singleton exported as `analysisRepository`.

## HTTP read interface
- `GET /api/repository` — all entries ordered by updatedAt desc
- `GET /api/repository/:module` — single module entry or 404

These endpoints are read-only. Write access is server-internal only.

## Adding a new module
1. Import `analysisRepository` in the route file.
2. Call `analysisRepository.save("module-name", parsed.data)` before `res.json(...)`.
3. No other changes needed — the repository API is already generic.

**Why:** Prevents point-to-point coupling between modules as the platform grows. Swapping in-memory storage for a database later only requires changing `analysis-repository.ts` without touching any module routes.
