/**
 * Command Brief — Deterministic Catalyst Item Enforcement Tests
 *
 * Covers all spec-required scenarios (no OpenAI, no pino, no route deps).
 *
 * CB-A  HIGH_INTEREST + WaitForEvent omitted by AI → inserted
 * CB-B  Candidate already represented correctly → no change (no duplicate)
 * CB-C  Candidate present but wording loses WaitForEvent → corrected in place
 * CB-D  Multiple qualifying catalysts → nearest (lowest daysUntilEvent) guaranteed
 * CB-E  Max 6 items enforced — lowest-priority generic item evicted when full
 * CB-F  Zero ready trades doesn't break enforcement (actionStatus unchanged)
 * CB-G  No qualifying catalyst (only INVESTIGATE) → existing behavior unchanged
 * CB-H  Ticker in OF but not HIGH_INTEREST → not enforced
 * CB-I  Ticker represented with symbol field match → detected as present
 * CB-J  Exchange-suffix ticker match (KEYS vs KEYS:XNAS) → deduped correctly
 * CB-K  HIGH_INTEREST + Review decision omitted → inserted with review wording
 * CB-L  Cap eviction prefers non-action, non-symbol items
 * CB-M  No TDE decision for HIGH_INTEREST candidate → not enforced
 * CB-N  findLowestPriorityItemIndex: action item protected from eviction
 * CB-O  communicatesDecisionState: WaitForEvent variants
 * CB-P  buildRequiredItemText: WaitForEvent and non-WaitForEvent shapes
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  enforceRequiredCatalystItems,
  findTopQualifyingCandidate,
  findMatchingItemIndex,
  communicatesDecisionState,
  buildRequiredItemText,
  findLowestPriorityItemIndex,
  BRIEF_MAX_ITEMS,
  type BriefItem,
  type CatalystCandidateCompact,
  type TdeDecisionCompact,
} from "../command-brief-catalyst-enforcement.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCandidate(
  ticker: string,
  daysUntilEvent: number,
  interestLevel: CatalystCandidateCompact["interestLevel"] = "HIGH_INTEREST"
): CatalystCandidateCompact {
  return {
    ticker,
    company: `${ticker} Corp`,
    event: `Earnings in ${daysUntilEvent}d`,
    daysUntilEvent,
    interestLevel,
    oneLineReason: `Strong pre-event setup for ${ticker} with positive momentum.`,
  };
}

function makeTde(ticker: string, decision: string): TdeDecisionCompact {
  return { ticker, decision };
}

function makeItem(
  text: string,
  opts: Partial<BriefItem> = {}
): BriefItem {
  return {
    category: "market",
    severity: "neutral",
    text,
    ...opts,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("enforceRequiredCatalystItems", () => {

  // CB-A  Omitted → inserted ──────────────────────────────────────────────────
  test("CB-A: HIGH_INTEREST WaitForEvent omitted by AI → inserted", () => {
    const items: BriefItem[] = [
      makeItem("Jackson Hole symposium this week — macro volatility expected."),
      makeItem("NVDA earnings next week.", { symbol: "NVDA", category: "stock", severity: "watch" }),
    ];
    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { items: result, inserted, enforcedTicker } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.ok(inserted, "item should have been inserted");
    assert.equal(enforcedTicker, "KEYS");
    const keysItem = result.find(i => i.symbol === "KEYS" || i.text.startsWith("KEYS:"));
    assert.ok(keysItem, "KEYS must appear in result");
    assert.ok(
      keysItem!.text.toLowerCase().includes("wait"),
      `WaitForEvent must be in text, got: "${keysItem!.text}"`
    );
  });

  // CB-B  Already correct → no duplicate ─────────────────────────────────────
  test("CB-B: candidate already represented correctly → no change", () => {
    const items: BriefItem[] = [
      makeItem("KEYS: Wait for earnings in 2 days before reassessment — Catalyst Intelligence sees a positive setup.", {
        symbol: "KEYS", category: "stock", severity: "watch",
      }),
    ];
    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { items: result, inserted, corrected } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(inserted, false);
    assert.equal(corrected, false);
    assert.equal(result.length, 1, "no duplicate should be added");
  });

  // CB-C  Present but wrong wording → corrected ──────────────────────────────
  test("CB-C: KEYS present but no WaitForEvent in text → text corrected", () => {
    const items: BriefItem[] = [
      makeItem("Keysight Technologies positioned for strong performance with earnings in 2 days.", {
        symbol: "KEYS", category: "stock", severity: "positive",
      }),
    ];
    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { items: result, inserted, corrected } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(inserted, false);
    assert.ok(corrected, "text should have been corrected");
    assert.equal(result.length, 1, "no new item added — existing item was corrected");
    assert.ok(result[0].text.toLowerCase().includes("wait"), `corrected text must say wait, got: "${result[0].text}"`);
  });

  // CB-D  Multiple catalysts → nearest guaranteed ────────────────────────────
  test("CB-D: multiple qualifying catalysts → most imminent (lowest daysUntilEvent) enforced", () => {
    const items: BriefItem[] = [];
    const catalysts = [
      makeCandidate("V",    9),
      makeCandidate("KEYS", 2),   // nearest
      makeCandidate("DCI",  10),
    ];
    const tde = [
      makeTde("V",    "WaitForEvent"),
      makeTde("KEYS", "WaitForEvent"),
      makeTde("DCI",  "WaitForEvent"),
    ];

    const { enforcedTicker } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(enforcedTicker, "KEYS", "KEYS (2 days) is most imminent and must be enforced first");
  });

  // CB-E  Max 6 items enforced ───────────────────────────────────────────────
  test("CB-E: at 6 items, lowest-priority generic item evicted to make room", () => {
    const items: BriefItem[] = [
      makeItem("Market sentiment remains cautious.", { category: "market", severity: "neutral" }),
      makeItem("Bond yields elevated.", { category: "market", severity: "neutral" }),
      makeItem("VIX above 20 — elevated volatility.", { category: "market", severity: "watch" }),
      makeItem("Sector rotation into defensives.", { category: "market", severity: "neutral" }),
      makeItem("Jackson Hole: Fed commentary awaited.", { category: "event", severity: "watch" }),
      makeItem("NVDA: Strong AI tailwinds.", { symbol: "NVDA", category: "stock", severity: "positive" }),
    ];
    assert.equal(items.length, BRIEF_MAX_ITEMS);

    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { items: result, inserted } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.ok(inserted);
    assert.equal(result.length, BRIEF_MAX_ITEMS, "must stay at max 6 items");
    const keysItem = result.find(i => i.symbol === "KEYS" || i.text.startsWith("KEYS:"));
    assert.ok(keysItem, "KEYS must be in the result");
  });

  // CB-F  Zero ready trades: actionStatus NOT modified ────────────────────────
  test("CB-F: enforcement does not modify actionStatus — Trade Review authority preserved", () => {
    // The enforcement function only operates on items[], never on actionStatus.
    // This test verifies the function's output shape doesn't include actionStatus at all.
    const items: BriefItem[] = [];
    const result = enforceRequiredCatalystItems(items, [], []);
    // Result must only have: items, inserted, corrected, enforcedTicker
    assert.ok(!("actionStatus" in result), "enforcement must not produce or modify actionStatus");
    assert.ok("items" in result);
    assert.ok("inserted" in result);
    assert.ok("corrected" in result);
    assert.ok("enforcedTicker" in result);
  });

  // CB-G  No qualifying catalyst → unchanged ─────────────────────────────────
  test("CB-G: no qualifying catalyst (INVESTIGATE only) → items unchanged", () => {
    const items: BriefItem[] = [makeItem("Market sentiment cautious.")];
    const catalysts = [makeCandidate("XYZ", 3, "INVESTIGATE")]; // not HIGH_INTEREST
    const tde = [makeTde("XYZ", "WaitForEvent")];

    const { items: result, inserted, corrected, enforcedTicker } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(result.length, 1);
    assert.equal(inserted, false);
    assert.equal(corrected, false);
    assert.equal(enforcedTicker, null);
  });

  // CB-H  Empty upcomingOpportunities → unchanged ────────────────────────────
  test("CB-H: empty upcomingOpportunities → existing behavior unchanged", () => {
    const items: BriefItem[] = [makeItem("Macro: Fed watch continues.")];
    const { items: result, inserted, corrected } = enforceRequiredCatalystItems(items, [], []);
    assert.deepEqual(result, items);
    assert.equal(inserted, false);
    assert.equal(corrected, false);
  });

  // CB-I  Symbol field match → detected as present ───────────────────────────
  test("CB-I: item with symbol=KEYS and correct wording → detected without text-prefix check", () => {
    const items: BriefItem[] = [
      makeItem("Waiting for KEYS earnings — positive catalyst setup identified.", {
        symbol: "KEYS", category: "stock", severity: "watch",
      }),
    ];
    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { inserted, corrected } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(inserted, false, "should not re-insert when symbol matches and wording is correct");
    assert.equal(corrected, false);
  });

  // CB-J  Exchange-suffix match ──────────────────────────────────────────────
  test("CB-J: TDE ticker KEYS:XNAS matches candidate KEYS → deduped correctly", () => {
    const items: BriefItem[] = [
      makeItem("KEYS: Wait for earnings in 2 days — positive setup.", {
        symbol: "KEYS", category: "stock", severity: "watch",
      }),
    ];
    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS:XNAS", "WaitForEvent")]; // exchange-qualified ticker

    const { inserted, corrected } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(inserted, false, "KEYS:XNAS must match KEYS and prevent re-insertion");
    assert.equal(corrected, false);
  });

  // CB-K  Review decision → correct review wording ───────────────────────────
  test("CB-K: HIGH_INTEREST + Review omitted → inserted with review wording", () => {
    const items: BriefItem[] = [];
    const catalysts = [makeCandidate("0700", 1)];
    const tde = [makeTde("0700", "Review")];

    const { items: result, inserted } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.ok(inserted);
    const item = result.find(i => i.symbol === "0700" || i.text.includes("0700"));
    assert.ok(item, "0700 must appear");
    assert.ok(
      item!.text.toLowerCase().includes("review"),
      `Review wording expected, got: "${item!.text}"`
    );
  });

  // CB-L  Eviction protects action items ────────────────────────────────────
  test("CB-L: eviction prefers non-action neutral items over action/warning items", () => {
    const items: BriefItem[] = [
      makeItem("Trade ready: Buy NVDA (pending approval).", { category: "action", severity: "critical", symbol: "NVDA" }),
      makeItem("Risk score elevated: 72/100.", { category: "risk", severity: "warning" }),
      makeItem("Macro caution: broad market.", { category: "market", severity: "neutral" }),   // ← should be evicted
      makeItem("SERV: Review Serve Robotics Q3.", { category: "stock", severity: "watch", symbol: "SERV" }),
      makeItem("Jackson Hole fed commentary this week.", { category: "event", severity: "watch" }),
      makeItem("Sector: Tech rotation positive.", { category: "market", severity: "positive" }),
    ];
    assert.equal(items.length, 6);

    const catalysts = [makeCandidate("KEYS", 2)];
    const tde = [makeTde("KEYS", "WaitForEvent")];

    const { items: result } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(result.length, 6);
    // Action item must survive
    assert.ok(result.some(i => i.category === "action"), "action item must not be evicted");
    // KEYS must be present
    assert.ok(result.some(i => i.symbol === "KEYS" || i.text.startsWith("KEYS:")));
    // "Sector: Tech rotation positive." has severity=positive (score=1) which is lower than
    // "Macro caution: broad market" severity=neutral (score=2) — it is the correct eviction target.
    assert.ok(!result.some(i => i.text.includes("Tech rotation")), "positive-severity generic item (lowest score) must be evicted");
  });

  // CB-M  No TDE decision for candidate → not enforced ──────────────────────
  test("CB-M: HIGH_INTEREST candidate with no matching TDE decision → not enforced", () => {
    const items: BriefItem[] = [];
    const catalysts = [makeCandidate("XYZ", 1)];
    const tde: TdeDecisionCompact[] = []; // no matching decision

    const { inserted, enforcedTicker } = enforceRequiredCatalystItems(items, catalysts, tde);

    assert.equal(inserted, false);
    assert.equal(enforcedTicker, null);
  });
});

// ── Unit tests for helpers ────────────────────────────────────────────────────

describe("findTopQualifyingCandidate", () => {
  test("CB-N: returns null when no HIGH_INTEREST candidate has a TDE decision", () => {
    const result = findTopQualifyingCandidate(
      [makeCandidate("XYZ", 1, "INVESTIGATE")],
      [makeTde("XYZ", "WaitForEvent")]
    );
    assert.equal(result, null);
  });

  test("CB-O: selects most imminent (lowest daysUntilEvent)", () => {
    const result = findTopQualifyingCandidate(
      [makeCandidate("A", 5), makeCandidate("B", 2), makeCandidate("C", 10)],
      [makeTde("A", "WaitForEvent"), makeTde("B", "Review"), makeTde("C", "Hold")]
    );
    assert.ok(result);
    assert.equal(result!.candidate.ticker, "B");
  });
});

describe("findLowestPriorityItemIndex", () => {
  test("CB-P: action item has highest score — never selected for eviction when alternatives exist", () => {
    const items: BriefItem[] = [
      makeItem("generic news", { category: "market", severity: "neutral" }),
      makeItem("trade ready", { category: "action", severity: "critical" }),
    ];
    const idx = findLowestPriorityItemIndex(items);
    assert.equal(idx, 0, "neutral market item should be selected, not action item");
  });
});

describe("communicatesDecisionState", () => {
  test("CB-Q: WaitForEvent — 'wait' present → true", () => {
    assert.ok(communicatesDecisionState(makeItem("KEYS: Wait for earnings."), "WaitForEvent"));
  });

  test("CB-R: WaitForEvent — no 'wait' or 'waiting' → false", () => {
    assert.ok(!communicatesDecisionState(makeItem("KEYS: Strong setup ahead of earnings."), "WaitForEvent"));
  });

  test("CB-S: Review — 'review' present → true", () => {
    assert.ok(communicatesDecisionState(makeItem("Under review pending data."), "Review"));
  });
});

describe("buildRequiredItemText", () => {
  test("CB-T: WaitForEvent produces wait-led text", () => {
    const text = buildRequiredItemText("KEYS", "Earnings in 2d", "WaitForEvent", "Positive setup");
    assert.ok(text.startsWith("KEYS:"), `must start with ticker: "${text}"`);
    assert.ok(text.toLowerCase().includes("wait"));
  });

  test("CB-U: Review produces review-led text", () => {
    const text = buildRequiredItemText("0700", "Earnings in 1d", "Review", "Strong setup");
    assert.ok(text.toLowerCase().includes("review"));
  });

  test("CB-V: unknown decision falls through to generic pattern", () => {
    const text = buildRequiredItemText("ABC", "Event in 5d", "NoAction", "Positive setup");
    assert.ok(text.includes("ABC:"));
    assert.ok(text.includes("NoAction") || text.toLowerCase().includes("noaction") || text.toLowerCase().includes("no action"));
  });
});
