---
name: Debug dialog crashes on partial/empty lastDebug object
description: lastDebug must be AiDebugInfo|undefined, never initialized as {}. An empty-but-truthy object causes a silent TypeError in the DebugDialog when it tries to access .request.model.
---

## Rule
In every AI route, initialize `lastDebug` as:
```typescript
let lastDebug: AiDebugInfo | undefined;
```

Never use `let lastDebug: Partial<AiDebugInfo> = {}`.

In the catch block, only merge when there's something to merge:
```typescript
const errDebug = extractAiErrorDebug(err);
if (lastDebug || errDebug) {
  lastDebug = { ...(lastDebug ?? {}), ...(errDebug ?? {}) } as AiDebugInfo;
}
```

**Why:** When `lastDebug = {}` (empty object), the error response sends `_debug: {}`. The frontend's `if (d) setDebugInfo(d)` check treats `{}` as truthy and stores it. The DebugDialog then tries `debugInfo.request.model` — with `request` undefined, this throws a silent TypeError that kills the dialog render, showing nothing instead of the expected content.

When `lastDebug` is `undefined`, `JSON.stringify` omits the `_debug` key entirely, `d` is falsy, `setDebugInfo` is not called, and the dialog correctly falls back to "No debug data available yet."

**How to apply:** All AI routes (market-monitor, event-monitor, etc.) already use `AiDebugInfo | undefined`. The DebugDialog in the frontend also needs `if (!req) return []` and optional chaining (`debugInfo.request?.model`) as defensive coding against any partial debug objects that might arrive.
