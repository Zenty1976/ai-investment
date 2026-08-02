---
name: callAiWithWebSearch calling convention
description: The function takes positional args (systemPrompt, userPrompt, options), not a single options object. Passing an object as the first arg puts the whole object into input[0].content and OpenAI returns a 400.
---

## Rule
Always call `callAiWithWebSearch` with positional arguments and destructure `result` (not `content`):

```typescript
const { result, debug } = await callAiWithWebSearch(
  SYSTEM_PROMPT,
  userPrompt,
  { model: "gpt-4o", maxTokens: 6000, temperature: 0.1 }
);
```

Never call it as `callAiWithWebSearch({ systemPrompt, userPrompt, maxTokens })`.

The function returns `{ result, debug, sources }` — NOT `{ content, debug }`. Destructuring `content` gives `undefined`, causing `content.match(...)` to throw immediately.

`callAiWithWebSearch` also parses the JSON internally — `result` is already the parsed object. Do NOT call `.match()` or `JSON.parse()` on it again; pass it directly to Zod `.safeParse()`.

**Why:** The function signature is `(systemPrompt: string, userPrompt: string, options?: AiServiceOptions)`. Passing an options object as the first argument sets `systemPrompt = { systemPrompt: ..., userPrompt: ..., maxTokens: ... }`, which gets placed into `input[0].content`. OpenAI's Responses API rejects this with `400 Invalid type for 'input[0].content': got an object instead of a string`.

**How to apply:** Any new route using `callAiWithWebSearch` must use positional args. The 400 error itself doesn't attach `_requestPayload` (it's a plain OpenAI.APIError, not a WebSearchError), so debug info won't appear in the dialog — the call simply needs to be correct.
