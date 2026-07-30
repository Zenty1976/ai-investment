# AI Investment

A modular AI-powered investment monitoring and decision support platform. First version implements the Market Monitor module — an AI-driven panel that analyses current market conditions and returns structured JSON via OpenAI.

## Run & Operate

- `pnpm --filter @workspace/ai-investment run dev` — run the frontend (port assigned by workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, TailwindCSS v4, shadcn/ui, wouter, TanStack Query
- API: Express 5
- AI: OpenAI (`gpt-4o-mini`) via shared AI service
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/ai-investment/` — React + Vite frontend
- `artifacts/api-server/` — Express API server
- `artifacts/api-server/src/lib/ai-service.ts` — **Shared AI service** — all modules must call OpenAI through this, never directly
- `artifacts/api-server/src/routes/market-monitor.ts` — Market Monitor route
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contracts)
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/` — generated Zod validation schemas

## Architecture decisions

- **Shared AI service** (`ai-service.ts`): Every future module calls `callAi()` from the shared service. Modules never import `openai` directly. This centralises model config, logging, and future rate limiting.
- **Structured JSON from OpenAI**: Every AI module defines its own Zod schema and uses `response_format: { type: "json_object" }`. Responses are validated with `.safeParse()` before use.
- **OpenAPI-first**: The spec in `lib/api-spec/openapi.yaml` is the contract. After each spec change, run codegen.
- **Dark-only UI**: The frontend always renders in dark mode (`dark` class added to `<html>` in `main.tsx`).

## Product

- **Market Monitor**: AI-powered panel showing market sentiment (Positive/Neutral/Negative), risk level (Low/Moderate/High), confidence score, positive/negative factors, strong/weak sectors, and key risks. Refreshed manually via "Run Analysis" button.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after changing `openapi.yaml`.
- `@apply dark` is NOT valid in Tailwind v4 — add the `dark` class to `document.documentElement` in JS instead.
- The shared AI service (`ai-service.ts`) lazily initialises the OpenAI client. `OPENAI_API_KEY` must be set as a Replit secret.
- When adding a new AI module, define its JSON schema in a shared location, validate with Zod before use, and always go through `callAi()`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
