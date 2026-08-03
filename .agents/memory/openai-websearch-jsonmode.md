---
name: Web search + JSON mode incompatible
description: OpenAI Responses API rejects json_object format mode when the web_search tool is active.
---

## Rule
Do not set `text: { format: { type: "json_object" } }` (jsonMode) on any Responses API call that also includes the `web_search` tool. The API returns HTTP 400: "Web Search cannot be used with JSON mode."

**Why:** Added jsonMode:true to callAiWithWebSearch to force structured output, which immediately broke all Company Monitor analyses with a 400 error.

## How to apply
- The `jsonMode` option in `ai-service.ts` is only valid for calls that do NOT use web search.
- For web-search calls, JSON robustness is achieved via: (1) explicit "begin with { end with }" instruction in system/retry prompts, (2) the prose-extraction fallback in ai-service.ts that locates the first `{` … last `}` in the response.
- `callAiWithWebSearch` must never receive `jsonMode: true`.
