---
name: Codegen manual split
description: orval codegen cleans the generated/ directories; manually-maintained types and hooks must live in separate manual.ts files.
---

## Rule
Never put hand-written types or hooks inside `lib/api-zod/src/generated/` or `lib/api-client-react/src/generated/`. The orval codegen runs with `clean: true` and deletes everything in those directories.

**Why:** Running `pnpm --filter @workspace/api-spec run codegen` wiped all manually-added Zod schemas and React hooks that had accumulated in the generated files over multiple sessions, breaking the entire app at once.

## How to apply
- Server Zod response schemas not in the OpenAPI spec → `lib/api-zod/src/manual.ts` (exported via `src/index.ts`)
- React hooks and TypeScript types not in the OpenAPI spec → `lib/api-client-react/src/manual.ts` (exported via `src/index.ts`)
- Both index files export `* from "./manual"` after `* from "./generated/..."`.
- When adding a new route: add types to the OpenAPI spec first (`lib/api-spec/openapi.yaml`) and regenerate. Only fall back to manual.ts when the route is not (yet) in the spec.
