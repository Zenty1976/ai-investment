---
name: Test runner — node:test with esbuild
description: How to run TypeScript tests in api-server when vitest is blocked by the package firewall.
---

## Rule
Vitest (all versions tried: 2.x, 1.x) is blocked by the package firewall. Use Node.js built-in `node:test` with a custom esbuild-based runner (`artifacts/api-server/run-tests.mjs`).

## How it works
1. `run-tests.mjs` finds all `*.test.ts` files under `src/lib/__tests__/`.
2. Bundles each with esbuild (same bundler as production — all deps inlined, only `node:*` external).
3. Spawns `node --test <compiled files>` with `cwd` set to a **fresh tmpdir** that has an empty `data/` directory.
4. After tests complete, both temp dirs are cleaned up.

**Why the cwd matters:** `analysis-repository.ts` resolves the data file as `process.cwd()/data/repository.json`. Without an isolated cwd, tests read/write the real development repository and accumulate state across runs, causing version number mismatches.

## Test file conventions
- Import from `node:test` and `node:assert/strict`.
- No `beforeEach` cleanup is needed — the fresh-cwd approach gives each test run an empty repo.
- Test files are excluded from the main `tsconfig.json` via `"exclude": ["src/**/__tests__"]` to avoid type errors about `node:test` vs other test frameworks.
- The `vitest.config.ts` file is present but unused (kept for future use when firewall rules change).

**How to apply:** When adding new test files, place them in `src/lib/__tests__/*.test.ts` and they will be picked up automatically by the runner.
