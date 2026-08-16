---
name: AI Chat Architecture
description: Isolated AI Chat module using OpenAI Responses API with previous_response_id for conversation continuity. Key isolation rules and patterns.
---

## Core architecture

- **Conversation continuity**: Responses API `store: true` + `previous_response_id` (not Assistants/Threads/Runs)
- Each `ChatConversation` stores `openAiLastResponseId` — the last response's `.id`. Passed as `previous_response_id` on next message.
- First message in a conversation: system prompt included in `input` array. Subsequent messages: only user text + `previous_response_id`.
- Tool-call loop: execute function_calls from `response.output`, submit as `function_call_output` items with `previous_response_id = response.id`, iterate up to `MAX_TOOL_ITERATIONS = 5`.

## Isolation rules

- `ai-chat-service.ts` has its OWN `_chatClient: OpenAI` — never shares with `ai-service.ts`
- `ai-chat-tools.ts` reads from `analysisRepository` via `.get()` only — never calls any module's analyze/run function
- Route `ai-chat.ts` does NOT import `automation-orchestrator` or any analysis service
- No automatic data push after Run All or Command Brief

**Why:** Spec requires zero behavioral change to existing modules. Any shared infrastructure with ai-service.ts risks unintended side effects.

## Tool naming convention

All tools start with `get_` — this makes it structurally obvious they are read-only. Tools returning per-ticker data take `{ ticker: string }` arg. Ticker-keyed repository entries follow existing pattern: `catalyst-intelligence:TICKER`, `company-monitor:TICKER`, `price-context:TICKER`.

## Persistence

- `data/chat-repository.json` (separate from `data/repository.json`)
- 200ms debounced write, synchronous read on startup
- `openAiLastResponseId` is the durable conversation link — must survive server restart

## Test pattern

- Source-reading tests (O, R) use structural/behavioral checks on the compiled module rather than reading `.ts` files at runtime — `process.cwd()` in test runner is a tmpdir, not source root.
- pino-based modules (ai-service.ts, logger.ts) cannot be dynamically imported in the test runner (node:os dynamic require issue).

## Frontend registration

- Route: `/ai-chat` in App.tsx
- Nav: `AI CHAT` in AppShell.tsx NAV_ITEMS
- Module: `ai-chat` in ModuleRegistry.tsx
- Default size: `{ w: 6, h: 5 }` in useDashboardLayout.ts DEFAULT_SIZES
- Uses `customFetch` from `@workspace/api-client-react` (not direct fetch or BASE_URL)
