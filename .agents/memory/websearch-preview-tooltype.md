---
name: web_search_preview tool type
description: OpenAI Responses API web search requires "web_search_preview" not "web_search"; the wrong type silently ignores search_context_size.
---

## Rule
Always use `type: "web_search_preview"` in the tools array for OpenAI Responses API web search calls. Using `"web_search"` is silently accepted but causes `search_context_size` to be completely ignored.

**Why:** When using `type: "web_search"`, OpenAI injects its maximum default web-content context (~17–18 k tokens) regardless of the `search_context_size` setting. With `type: "web_search_preview"`, the parameter is honoured and results are compact (~800–2,000 tokens for typical queries).

**Evidence from controlled test (2026-08-12):**
- `"web_search"` + medium: 17,782 prompt tokens for market-monitor
- `"web_search_preview"` + medium: 800 prompt tokens for market-monitor (-95.5%)
- `"web_search_preview"` + low: 800 prompt tokens (same — queries with compact results converge)
- news-monitor medium: 18,642 → 2,010 tokens after fix (-89%)

**How to apply:** The fix lives in `ai-service.ts` in `callAiWithWebSearch`. The `search_context_size` default is `"medium"` — leave it there; the fix alone eliminates the overage.
