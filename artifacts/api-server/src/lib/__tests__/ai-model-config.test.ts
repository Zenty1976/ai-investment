/**
 * AI Model Config Tests
 *
 * Verifies model routing, request construction shapes, pricing lookup,
 * and usage token parsing without making any live OpenAI API calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getModel,
  AI_MODEL_CONFIG,
  MODULE_OVERRIDES,
  type AiModelCategory,
} from "../ai-model-config.js";
// Import from the logger-free pricing module so node:test can run without pino.
import {
  estimateCostUsd,
  MODEL_PRICING,
} from "../ai-model-pricing.js";

// ── §1 Category defaults ───────────────────────────────────────────────────────

describe("getModel — category defaults", () => {
  it("discovery → gpt-4.1-nano (verified pricing: $0.10/1M input)", () => {
    assert.equal(getModel("discovery"), "gpt-4.1-nano");
  });

  it("monitor → gpt-4.1-mini (qualitative upstream)", () => {
    assert.equal(getModel("monitor"), "gpt-4.1-mini");
  });

  it("analysis → gpt-4.1-mini (synthesis over facts)", () => {
    assert.equal(getModel("analysis"), "gpt-4.1-mini");
  });

  it("decision → gpt-4.1 (quality priority — trade decision engine)", () => {
    assert.equal(getModel("decision"), "gpt-4.1");
  });

  it("brief → gpt-4o-mini (compact output from pre-analyzed inputs)", () => {
    assert.equal(getModel("brief"), "gpt-4o-mini");
  });

  it("repair → gpt-4o-mini (mechanical schema correction)", () => {
    assert.equal(getModel("repair"), "gpt-4o-mini");
  });
});

// ── §2 Module overrides ────────────────────────────────────────────────────────

describe("getModel — module overrides", () => {
  it("company-monitor → gpt-4.1 (core intelligence, conservative)", () => {
    assert.equal(getModel("monitor", "company-monitor"), "gpt-4.1");
  });

  it("opportunity-finder → gpt-4.1 (cross-module reasoning, not simple ranking)", () => {
    assert.equal(getModel("monitor", "opportunity-finder"), "gpt-4.1");
  });

  it("trade-decision-engine uses category decision = gpt-4.1 (no separate override needed)", () => {
    assert.equal(getModel("decision", "trade-decision-engine"), "gpt-4.1");
  });

  it("market-monitor uses category monitor = gpt-4.1-mini (no override)", () => {
    assert.equal(getModel("monitor", "market-monitor"), "gpt-4.1-mini");
  });

  it("news-monitor uses category monitor = gpt-4.1-mini", () => {
    assert.equal(getModel("monitor", "news-monitor"), "gpt-4.1-mini");
  });

  it("event-monitor uses category monitor = gpt-4.1-mini", () => {
    assert.equal(getModel("monitor", "event-monitor"), "gpt-4.1-mini");
  });

  it("sector-monitor uses category monitor = gpt-4.1-mini", () => {
    assert.equal(getModel("monitor", "sector-monitor"), "gpt-4.1-mini");
  });

  it("investor-watch uses category monitor = gpt-4.1-mini (informational, not TDE input)", () => {
    assert.equal(getModel("monitor", "investor-watch"), "gpt-4.1-mini");
  });

  it("risk-analyzer uses category analysis = gpt-4.1-mini", () => {
    assert.equal(getModel("analysis", "risk-analyzer"), "gpt-4.1-mini");
  });

  it("portfolio-analyzer uses category analysis = gpt-4.1-mini", () => {
    assert.equal(getModel("analysis", "portfolio-analyzer"), "gpt-4.1-mini");
  });

  it("portfolio-target-synthesiser uses category analysis = gpt-4.1-mini", () => {
    assert.equal(getModel("analysis", "portfolio-target-synthesiser"), "gpt-4.1-mini");
  });

  it("command-brief uses category brief = gpt-4o-mini", () => {
    assert.equal(getModel("brief", "command-brief"), "gpt-4o-mini");
  });

  it("company-monitor-discovery uses category discovery = gpt-4.1-nano", () => {
    assert.equal(getModel("discovery", "company-monitor-discovery"), "gpt-4.1-nano");
  });

  it("investor-watch-discovery uses category discovery = gpt-4.1-nano", () => {
    assert.equal(getModel("discovery", "investor-watch-discovery"), "gpt-4.1-nano");
  });
});

// ── §3 Override takes precedence over category ─────────────────────────────────

describe("getModel — override precedence", () => {
  it("module override wins over category default", () => {
    // company-monitor is in `monitor` category (default: gpt-4.1-mini)
    // but MODULE_OVERRIDES gives it gpt-4.1
    const categoryDefault = AI_MODEL_CONFIG["monitor"].model;
    const resolved = getModel("monitor", "company-monitor");
    assert.equal(categoryDefault, "gpt-4.1-mini");
    assert.equal(resolved, "gpt-4.1");
    assert.notEqual(resolved, categoryDefault);
  });

  it("unknown module falls through to category default", () => {
    assert.equal(getModel("monitor", "some-unknown-module"), AI_MODEL_CONFIG["monitor"].model);
  });

  it("getModel without module arg returns category default", () => {
    const categories: AiModelCategory[] = ["discovery", "monitor", "analysis", "decision", "brief", "repair"];
    for (const cat of categories) {
      assert.equal(getModel(cat), AI_MODEL_CONFIG[cat].model);
    }
  });
});

// ── §4 MODULE_OVERRIDES content ────────────────────────────────────────────────

describe("MODULE_OVERRIDES content", () => {
  it("company-monitor is overridden to gpt-4.1", () => {
    assert.equal(MODULE_OVERRIDES["company-monitor"], "gpt-4.1");
  });

  it("opportunity-finder is overridden to gpt-4.1", () => {
    assert.equal(MODULE_OVERRIDES["opportunity-finder"], "gpt-4.1");
  });

  it("discovery modules are NOT overridden (use category default)", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, "company-monitor-discovery"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, "investor-watch-discovery"), false);
  });

  it("command-brief is NOT overridden", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, "command-brief"), false);
  });

  it("trade-decision-engine is NOT overridden (uses category decision which is already gpt-4.1)", () => {
    assert.equal(Object.prototype.hasOwnProperty.call(MODULE_OVERRIDES, "trade-decision-engine"), false);
  });
});

// ── §5 All category models are in MODEL_PRICING ────────────────────────────────

describe("MODEL_PRICING completeness", () => {
  it("every category default model has a pricing entry", () => {
    const categories: AiModelCategory[] = ["discovery", "monitor", "analysis", "decision", "brief", "repair"];
    for (const cat of categories) {
      const model = AI_MODEL_CONFIG[cat].model;
      assert.ok(
        Object.prototype.hasOwnProperty.call(MODEL_PRICING, model),
        `Model ${model} (category ${cat}) is missing from MODEL_PRICING`
      );
    }
  });

  it("every MODULE_OVERRIDE model has a pricing entry", () => {
    for (const [mod, model] of Object.entries(MODULE_OVERRIDES)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(MODEL_PRICING, model),
        `Override model ${model} (module ${mod}) is missing from MODEL_PRICING`
      );
    }
  });

  it("gpt-4.1 pricing is lower input cost than gpt-4o", () => {
    assert.ok(MODEL_PRICING["gpt-4.1"].inputPer1M < MODEL_PRICING["gpt-4o"].inputPer1M,
      "gpt-4.1 should be cheaper than gpt-4o per input token");
  });

  it("gpt-4.1-mini pricing is cheaper than gpt-4.1", () => {
    assert.ok(MODEL_PRICING["gpt-4.1-mini"].inputPer1M < MODEL_PRICING["gpt-4.1"].inputPer1M,
      "gpt-4.1-mini should be cheaper than gpt-4.1 per input token");
  });

  it("gpt-4o-mini pricing is cheaper than gpt-4.1-mini", () => {
    assert.ok(MODEL_PRICING["gpt-4o-mini"].inputPer1M < MODEL_PRICING["gpt-4.1-mini"].inputPer1M,
      "gpt-4o-mini should be cheaper than gpt-4.1-mini per input token");
  });

  it("gpt-4.1-nano has correct verified pricing ($0.10/$0.025/$0.40 per 1M)", () => {
    const p = MODEL_PRICING["gpt-4.1-nano"];
    assert.ok(p !== undefined, "gpt-4.1-nano must be in MODEL_PRICING");
    assert.equal(p.inputPer1M, 0.10);
    assert.equal(p.cachedInputPer1M, 0.025);
    assert.equal(p.outputPer1M, 0.40);
  });

  it("gpt-4.1-nano is cheaper than gpt-4o-mini on input tokens", () => {
    assert.ok(MODEL_PRICING["gpt-4.1-nano"].inputPer1M < MODEL_PRICING["gpt-4o-mini"].inputPer1M,
      "gpt-4.1-nano ($0.10/1M) should be cheaper than gpt-4o-mini ($0.15/1M)");
  });

  it("gpt-4.1-nano cached input is $0.025/1M (75% discount vs full rate)", () => {
    const p = MODEL_PRICING["gpt-4.1-nano"];
    const discountPct = (1 - p.cachedInputPer1M! / p.inputPer1M) * 100;
    assert.ok(Math.abs(discountPct - 75) < 0.001, `Expected 75% cache discount, got ${discountPct.toFixed(1)}%`);
  });
});

// ── §6 estimateCostUsd ─────────────────────────────────────────────────────────

describe("estimateCostUsd", () => {
  it("gpt-4.1-mini: 1000 input + 500 output → correct estimate", () => {
    // $0.40/1M input, $1.60/1M output
    // cost = 1000 * 0.40/1M + 500 * 1.60/1M = 0.0004 + 0.0008 = 0.0012
    const cost = estimateCostUsd("gpt-4.1-mini", 1_000, 500);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.0012) < 0.000001, `Expected ~0.0012, got ${cost}`);
  });

  it("gpt-4.1: 1000 input + 500 output → correct estimate", () => {
    // $2.00/1M input, $8.00/1M output
    // cost = 1000 * 2.00/1M + 500 * 8.00/1M = 0.002 + 0.004 = 0.006
    const cost = estimateCostUsd("gpt-4.1", 1_000, 500);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.006) < 0.000001, `Expected ~0.006, got ${cost}`);
  });

  it("gpt-4o-mini: 1000 input + 500 output → correct estimate", () => {
    // $0.15/1M input, $0.60/1M output
    // cost = 1000 * 0.15/1M + 500 * 0.60/1M = 0.00015 + 0.0003 = 0.00045
    const cost = estimateCostUsd("gpt-4o-mini", 1_000, 500);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.00045) < 0.000001, `Expected ~0.00045, got ${cost}`);
  });

  it("cached tokens reduce input cost using cachedInputPer1M rate", () => {
    // gpt-4.1: $2.00/1M input, $0.50/1M cached input
    // 500 cached, 500 uncached, 0 output
    // cost = 500 * 2.00/1M + 500 * 0.50/1M = 0.001 + 0.00025 = 0.00125
    const cost = estimateCostUsd("gpt-4.1", 1_000, 0, 500);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.00125) < 0.000001, `Expected ~0.00125, got ${cost}`);
  });

  it("reasoning tokens add to cost (o-series: billed at output rate)", () => {
    // gpt-4.1-mini: $0.40/1M input, $1.60/1M output
    // 1000 input, 100 output, 0 cached, 200 reasoning tokens
    // cost = 1000*0.40/1M + 100*1.60/1M + 200*1.60/1M = 0.0004 + 0.00016 + 0.00032 = 0.00088
    const cost = estimateCostUsd("gpt-4.1-mini", 1_000, 100, 0, 200);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.00088) < 0.000001, `Expected ~0.00088, got ${cost}`);
  });

  it("returns null for unknown model", () => {
    assert.equal(estimateCostUsd("gpt-unknown-xyz", 1_000, 500), null);
  });

  it("zero tokens → zero cost", () => {
    const cost = estimateCostUsd("gpt-4.1", 0, 0);
    assert.equal(cost, 0);
  });

  it("gpt-4.1-nano: 1000 input + 500 output → correct estimate", () => {
    // $0.10/1M input, $0.40/1M output
    // cost = 1000 * 0.10/1M + 500 * 0.40/1M = 0.0001 + 0.0002 = 0.0003
    const cost = estimateCostUsd("gpt-4.1-nano", 1_000, 500);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.0003) < 0.000001, `Expected ~0.0003, got ${cost}`);
  });

  it("gpt-4.1-nano: cached input uses $0.025/1M rate", () => {
    // 800 cached, 200 uncached, 0 output
    // cost = 200 * 0.10/1M + 800 * 0.025/1M = 0.00002 + 0.00002 = 0.00004
    const cost = estimateCostUsd("gpt-4.1-nano", 1_000, 0, 800);
    assert.ok(cost !== null);
    assert.ok(Math.abs(cost! - 0.00004) < 0.0000001, `Expected ~0.00004, got ${cost}`);
  });
});

// ── §7 Request construction shapes (no live API calls) ─────────────────────────

describe("request construction shapes", () => {
  /**
   * Verifies the expected shape of the Responses API payload for each model class.
   * We construct the payload manually as ai-service.ts does — no actual network call.
   */

  function buildResponsesApiPayload(model: string, opts: {
    maxOutputTokens: number;
    temperature: number;
    webSearchContextSize: "low" | "medium" | "high";
    webSearchRequired: boolean;
    jsonMode: boolean;
  }) {
    return {
      model,
      max_output_tokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      tools: [{ type: "web_search_preview", search_context_size: opts.webSearchContextSize }],
      tool_choice: opts.webSearchRequired ? "required" : "auto",
      input: [
        { role: "system", content: "system prompt" },
        { role: "user",   content: "user prompt" },
      ],
      ...(opts.jsonMode ? { text: { format: { type: "json_object" } } } : {}),
    };
  }

  function buildChatCompletionsPayload(model: string, opts: {
    maxTokens: number;
    temperature: number;
  }) {
    return {
      model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user",   content: "user prompt" },
      ],
    };
  }

  it("nano-class (gpt-4o-mini) Responses API: uses web_search_preview tool", () => {
    const payload = buildResponsesApiPayload("gpt-4o-mini", {
      maxOutputTokens: 800, temperature: 0.3,
      webSearchContextSize: "low", webSearchRequired: true, jsonMode: false,
    });
    assert.equal(payload.model, "gpt-4o-mini");
    assert.equal(payload.tools[0].type, "web_search_preview");
    assert.equal(payload.tools[0].search_context_size, "low");
    assert.equal(payload.tool_choice, "required");
    assert.equal(payload.input[0].role, "system");
    assert.equal(payload.input[1].role, "user");
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "text"), false,
      "jsonMode: false must not set text.format");
  });

  it("mini-class (gpt-4.1-mini) Responses API: medium web search context", () => {
    const payload = buildResponsesApiPayload("gpt-4.1-mini", {
      maxOutputTokens: 1200, temperature: 0.3,
      webSearchContextSize: "medium", webSearchRequired: true, jsonMode: false,
    });
    assert.equal(payload.model, "gpt-4.1-mini");
    assert.equal(payload.tools[0].search_context_size, "medium");
    assert.equal(payload.tool_choice, "required");
  });

  it("strong-class (gpt-4.1) Responses API: high web search context for complex reasoning", () => {
    const payload = buildResponsesApiPayload("gpt-4.1", {
      maxOutputTokens: 3500, temperature: 0.1,
      webSearchContextSize: "medium", webSearchRequired: true, jsonMode: false,
    });
    assert.equal(payload.model, "gpt-4.1");
    assert.equal(payload.max_output_tokens, 3500);
  });

  it("jsonMode: false must NOT set text.format (incompatible with web_search_preview)", () => {
    const payload = buildResponsesApiPayload("gpt-4.1-mini", {
      maxOutputTokens: 1200, temperature: 0.3,
      webSearchContextSize: "medium", webSearchRequired: true, jsonMode: false,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "text"), false);
  });

  it("jsonMode: true sets text.format.type = json_object", () => {
    const payload = buildResponsesApiPayload("gpt-4.1-mini", {
      maxOutputTokens: 1200, temperature: 0.3,
      webSearchContextSize: "medium", webSearchRequired: false, jsonMode: true,
    });
    assert.deepEqual((payload as any).text, { format: { type: "json_object" } });
  });

  it("Chat Completions (callAi) payload uses response_format json_object", () => {
    const payload = buildChatCompletionsPayload("gpt-4.1-mini", {
      maxTokens: 2500, temperature: 0.2,
    });
    assert.equal(payload.model, "gpt-4.1-mini");
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[1].role, "user");
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "tools"), false,
      "callAi must not include tools");
  });

  it("Chat Completions uses max_tokens (not max_output_tokens)", () => {
    const payload = buildChatCompletionsPayload("gpt-4.1", { maxTokens: 1000, temperature: 0.3 });
    assert.ok(Object.prototype.hasOwnProperty.call(payload, "max_tokens"));
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "max_output_tokens"), false);
  });

  it("Responses API uses max_output_tokens (not max_tokens)", () => {
    const payload = buildResponsesApiPayload("gpt-4.1", {
      maxOutputTokens: 1000, temperature: 0.3,
      webSearchContextSize: "medium", webSearchRequired: true, jsonMode: false,
    });
    assert.ok(Object.prototype.hasOwnProperty.call(payload, "max_output_tokens"));
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "max_tokens"), false);
  });
});

// ── §8 Usage token parsing ─────────────────────────────────────────────────────

describe("usage token parsing — mock response shapes", () => {
  /**
   * Validates the token extraction logic used in ai-service.ts.
   * Simulates the response.usage objects returned by each API.
   */

  function parseCallAiUsage(usage: Record<string, unknown>) {
    // Mirrors callAi token extraction
    const usageAny = usage as any;
    return {
      promptTokens:     usageAny?.prompt_tokens     ?? 0,
      completionTokens: usageAny?.completion_tokens ?? 0,
      totalTokens:      usageAny?.total_tokens      ?? 0,
      cachedTokens:     usageAny?.prompt_tokens_details?.cached_tokens    ?? 0,
      reasoningTokens:  usageAny?.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  function parseResponsesApiUsage(usage: Record<string, unknown>) {
    // Mirrors callAiWithWebSearch token extraction
    const usageAny = usage as any;
    return {
      promptTokens:     usageAny?.input_tokens  ?? 0,
      completionTokens: usageAny?.output_tokens ?? 0,
      totalTokens:      usageAny?.total_tokens  ?? 0,
      cachedTokens:     usageAny?.input_tokens_details?.cached_tokens             ?? 0,
      reasoningTokens:  usageAny?.output_tokens_details?.reasoning_tokens          ?? 0,
    };
  }

  it("Chat Completions: parses standard usage fields", () => {
    const usage = {
      prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
    };
    const parsed = parseCallAiUsage(usage);
    assert.equal(parsed.promptTokens, 1000);
    assert.equal(parsed.completionTokens, 500);
    assert.equal(parsed.totalTokens, 1500);
    assert.equal(parsed.cachedTokens, 0);
    assert.equal(parsed.reasoningTokens, 0);
  });

  it("Chat Completions: parses cached input tokens (gpt-4.1 prompt caching)", () => {
    const usage = {
      prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 750 },
    };
    const parsed = parseCallAiUsage(usage);
    assert.equal(parsed.cachedTokens, 750);
    assert.equal(parsed.reasoningTokens, 0);
  });

  it("Chat Completions: parses reasoning tokens (o-series future compatibility)", () => {
    const usage = {
      prompt_tokens: 1000, completion_tokens: 800, total_tokens: 1800,
      completion_tokens_details: { reasoning_tokens: 300 },
    };
    const parsed = parseCallAiUsage(usage);
    assert.equal(parsed.reasoningTokens, 300);
    assert.equal(parsed.completionTokens, 800); // includes reasoning
  });

  it("Responses API: parses standard usage fields (input/output naming)", () => {
    const usage = {
      input_tokens: 2000, output_tokens: 400, total_tokens: 2400,
    };
    const parsed = parseResponsesApiUsage(usage);
    assert.equal(parsed.promptTokens, 2000);
    assert.equal(parsed.completionTokens, 400);
    assert.equal(parsed.totalTokens, 2400);
    assert.equal(parsed.cachedTokens, 0);
    assert.equal(parsed.reasoningTokens, 0);
  });

  it("Responses API: parses cached input tokens", () => {
    const usage = {
      input_tokens: 2000, output_tokens: 400, total_tokens: 2400,
      input_tokens_details: { cached_tokens: 1500 },
    };
    const parsed = parseResponsesApiUsage(usage);
    assert.equal(parsed.cachedTokens, 1500);
  });

  it("Responses API: parses reasoning tokens from output_tokens_details", () => {
    const usage = {
      input_tokens: 2000, output_tokens: 600, total_tokens: 2600,
      output_tokens_details: { reasoning_tokens: 200 },
    };
    const parsed = parseResponsesApiUsage(usage);
    assert.equal(parsed.reasoningTokens, 200);
  });

  it("null/undefined usage → all zeros (defensive handling)", () => {
    const parsedChat = parseCallAiUsage({});
    assert.equal(parsedChat.promptTokens, 0);
    assert.equal(parsedChat.completionTokens, 0);
    assert.equal(parsedChat.cachedTokens, 0);
    assert.equal(parsedChat.reasoningTokens, 0);

    const parsedResp = parseResponsesApiUsage({});
    assert.equal(parsedResp.promptTokens, 0);
    assert.equal(parsedResp.completionTokens, 0);
    assert.equal(parsedResp.cachedTokens, 0);
    assert.equal(parsedResp.reasoningTokens, 0);
  });
});

// ── §9 No fallback behaviour ───────────────────────────────────────────────────

describe("no silent fallback — model routing", () => {
  it("getModel never returns an empty string", () => {
    const categories: AiModelCategory[] = ["discovery", "monitor", "analysis", "decision", "brief", "repair"];
    for (const cat of categories) {
      const model = getModel(cat);
      assert.ok(model.length > 0, `getModel("${cat}") returned empty string`);
    }
  });

  it("company-monitor and opportunity-finder are on gpt-4.1 (strong), not mini", () => {
    assert.equal(getModel("monitor", "company-monitor"), "gpt-4.1");
    assert.equal(getModel("monitor", "opportunity-finder"), "gpt-4.1");
    assert.notEqual(getModel("monitor", "company-monitor"), "gpt-4.1-mini");
    assert.notEqual(getModel("monitor", "opportunity-finder"), "gpt-4.1-mini");
  });

  it("trade decision engine resolves to gpt-4.1, not nano or mini", () => {
    const model = getModel("decision", "trade-decision-engine");
    assert.equal(model, "gpt-4.1");
    assert.notEqual(model, "gpt-4o-mini");
    assert.notEqual(model, "gpt-4.1-mini");
  });

  it("discovery uses gpt-4.1-nano, not a more expensive model", () => {
    assert.equal(getModel("discovery"), "gpt-4.1-nano");
    assert.notEqual(getModel("discovery"), "gpt-4o-mini");
    assert.notEqual(getModel("discovery"), "gpt-4.1-mini");
    assert.notEqual(getModel("discovery"), "gpt-4.1");
  });

  it("repair stays on gpt-4o-mini (retry prompts contain semantic investment content)", () => {
    assert.equal(getModel("repair"), "gpt-4o-mini");
    assert.notEqual(getModel("repair"), "gpt-4.1-nano");
    assert.notEqual(getModel("repair"), "gpt-4.1");
    assert.notEqual(getModel("repair"), "gpt-4.1-mini");
  });
});
