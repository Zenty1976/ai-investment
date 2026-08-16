/**
 * Command Brief — Deterministic Catalyst Item Enforcement
 *
 * After the AI produces a Command Brief, this layer guarantees that the
 * highest-priority qualifying catalyst candidate (HIGH_INTEREST + explicit
 * Trade Decision) is always represented in the items array with wording that
 * correctly communicates the Trade Decision state.
 *
 * Zero AI calls. Zero external dependencies. Pure function — safe to test.
 *
 * Rules (spec §5–10):
 *  - Only HIGH_INTEREST interestLevel qualifies (covers HighInterest and
 *    CandidateForTradeDecision opportunityStates from Catalyst Intelligence).
 *  - Candidate must have a matching TDE decision.
 *  - Nearest event (lowest daysUntilEvent) is highest priority.
 *  - At least the top-priority qualifying candidate must be represented.
 *  - If omitted → insert (removing lowest-priority generic item if at max cap).
 *  - If present but wording loses Trade Decision state → correct text in place.
 *  - If already correctly represented → no change.
 *  - No duplicates. Max items cap enforced.
 *  - actionStatus and all other fields are NOT modified — Trade Review
 *    authority is preserved by design.
 */

export const BRIEF_MAX_ITEMS = 6;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BriefItem {
  category:
    | "system" | "portfolio" | "risk" | "market"
    | "stock" | "event" | "opportunity" | "action";
  severity: "positive" | "neutral" | "watch" | "warning" | "critical";
  symbol?: string;
  text: string;
}

/** Minimal shape of an upcoming catalyst as built by buildUpcomingOpportunities(). */
export interface CatalystCandidateCompact {
  ticker: string;
  company: string;
  event: string;           // e.g. "Earnings in 2d"
  daysUntilEvent: number;
  interestLevel: "HIGH_INTEREST" | "INVESTIGATE" | "MONITOR";
  oneLineReason: string;   // abbreviated thesis
}

/** Minimal shape of a TDE decision as extracted from the repository. */
export interface TdeDecisionCompact {
  ticker: string;  // may include exchange suffix e.g. "KEYS" or "NOVOB:XCSE"
  decision: string;
}

export interface EnforcementResult {
  items: BriefItem[];
  /** True if a new item was inserted because the candidate was missing. */
  inserted: boolean;
  /** True if an existing item's text was corrected to include the decision state. */
  corrected: boolean;
  /** Ticker that was enforced, or null if no qualifying candidate existed. */
  enforcedTicker: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Case-insensitive ticker match that tolerates exchange suffixes.
 * "KEYS" matches "KEYS", "KEYS:XNAS", etc.
 */
function tickerMatches(a: string, b: string): boolean {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua === ub || ua.startsWith(ub + ":") || ub.startsWith(ua + ":");
}

/**
 * Find the highest-priority qualifying candidate:
 *  - interestLevel must be HIGH_INTEREST
 *  - must have a matching TDE decision
 *  - sorted by daysUntilEvent ascending (most imminent first)
 */
export function findTopQualifyingCandidate(
  upcomingOpportunities: ReadonlyArray<CatalystCandidateCompact>,
  tdeDecisions: ReadonlyArray<TdeDecisionCompact>
): { candidate: CatalystCandidateCompact; decision: string } | null {
  const qualifying = upcomingOpportunities
    .filter(c => c.interestLevel === "HIGH_INTEREST")
    .filter(c => {
      const match = tdeDecisions.find(d => tickerMatches(d.ticker, c.ticker));
      return match !== undefined && typeof match.decision === "string" && match.decision.length > 0;
    })
    .slice() // don't mutate input
    .sort((a, b) => a.daysUntilEvent - b.daysUntilEvent);

  if (qualifying.length === 0) return null;

  const candidate = qualifying[0];
  const matched = tdeDecisions.find(d => tickerMatches(d.ticker, candidate.ticker))!;
  return { candidate, decision: matched.decision };
}

/**
 * Return the index of the first item that mentions the ticker
 * (via symbol field or text starting with "TICKER:").
 * Returns -1 if not found.
 */
export function findMatchingItemIndex(items: ReadonlyArray<BriefItem>, ticker: string): number {
  return items.findIndex(item =>
    (item.symbol !== undefined && tickerMatches(item.symbol, ticker)) ||
    item.text.toUpperCase().startsWith(ticker.toUpperCase() + ":")
  );
}

/**
 * True if the item text communicates the Trade Decision state clearly enough.
 * Conservative matching — requires a word from the decision type to be present.
 */
export function communicatesDecisionState(item: BriefItem, decision: string): boolean {
  const text = item.text.toLowerCase();
  switch (decision) {
    case "WaitForEvent":   return text.includes("wait") || text.includes("waiting");
    case "Review":         return text.includes("review") || text.includes("reassess");
    case "PrepareToBuy":   return text.includes("prepar") || text.includes("buy");
    case "PrepareToReduce":return text.includes("prepar") || text.includes("reduc");
    case "Hold":           return text.includes("hold");
    case "NoAction":       return text.includes("no action") || text.includes("noaction");
    default:               return text.includes(decision.toLowerCase());
  }
}

/**
 * Build the required item text for a qualifying catalyst candidate.
 * Trade Decision state leads; Catalyst sentiment is secondary.
 */
export function buildRequiredItemText(
  ticker: string,
  event: string,
  decision: string,
  oneLineReason: string
): string {
  const hint = oneLineReason.slice(0, 60) + (oneLineReason.length > 60 ? "…" : "");
  switch (decision) {
    case "WaitForEvent":
      return `${ticker}: Wait for ${event} before reassessment — Catalyst Intelligence sees a positive setup.`;
    case "Review":
      return `${ticker}: Under review ahead of ${event} — ${hint}`;
    case "PrepareToBuy":
      return `${ticker}: Preparing to buy ahead of ${event} — ${hint}`;
    case "PrepareToReduce":
      return `${ticker}: Preparing to reduce ahead of ${event} — ${hint}`;
    case "Hold":
      return `${ticker}: Hold through ${event} — ${hint}`;
    default:
      return `${ticker}: ${decision} — ${event} upcoming; ${hint}`;
  }
}

/**
 * Find the index of the item that is safest to remove when the list is full.
 * Lowest-priority = lowest score. Action items and symbol-specific items are protected.
 */
export function findLowestPriorityItemIndex(items: ReadonlyArray<BriefItem>): number {
  const score = (item: BriefItem): number => {
    let s = 0;
    if (item.category === "action") s += 100;      // never remove
    if (item.symbol)                s += 10;        // stock-specific — prefer to keep
    switch (item.severity) {
      case "critical": s += 8; break;
      case "warning":  s += 6; break;
      case "watch":    s += 4; break;
      case "neutral":  s += 2; break;
      case "positive": s += 1; break;
    }
    return s;
  };

  let minScore = Infinity;
  let minIndex = items.length - 1; // default: last item
  for (let i = 0; i < items.length; i++) {
    const s = score(items[i]);
    if (s < minScore) {
      minScore = s;
      minIndex = i;
    }
  }
  return minIndex;
}

// ── Main enforcement function ─────────────────────────────────────────────────

/**
 * Guarantee the highest-priority qualifying Catalyst candidate is represented
 * in the Command Brief items with correct Trade Decision wording.
 *
 * This function is idempotent and pure — it does not modify any input array.
 *
 * @param items               AI-generated items (from RunCommandBriefResponse)
 * @param upcomingOpportunities  From buildUpcomingOpportunities()
 * @param tdeDecisions           Full (unsliced) TDE decision list
 * @param maxItems               Cap (default: BRIEF_MAX_ITEMS = 6)
 */
export function enforceRequiredCatalystItems(
  items: ReadonlyArray<BriefItem>,
  upcomingOpportunities: ReadonlyArray<CatalystCandidateCompact>,
  tdeDecisions: ReadonlyArray<TdeDecisionCompact>,
  maxItems: number = BRIEF_MAX_ITEMS
): EnforcementResult {
  const top = findTopQualifyingCandidate(upcomingOpportunities, tdeDecisions);

  // No qualifying candidate — return unchanged
  if (!top) {
    return { items: [...items], inserted: false, corrected: false, enforcedTicker: null };
  }

  const { candidate, decision } = top;
  const requiredText = buildRequiredItemText(
    candidate.ticker, candidate.event, decision, candidate.oneLineReason
  );

  const existingIdx = findMatchingItemIndex(items, candidate.ticker);

  // Case 1: already present and correctly worded — no change
  if (existingIdx !== -1 && communicatesDecisionState(items[existingIdx], decision)) {
    return { items: [...items], inserted: false, corrected: false, enforcedTicker: candidate.ticker };
  }

  // Case 2: present but wrong wording — correct text in place
  if (existingIdx !== -1) {
    const corrected = [...items];
    corrected[existingIdx] = { ...corrected[existingIdx], text: requiredText };
    return { items: corrected, inserted: false, corrected: true, enforcedTicker: candidate.ticker };
  }

  // Case 3: missing — insert (evicting lowest-priority item if at cap)
  const working = [...items];
  if (working.length >= maxItems) {
    const removeIdx = findLowestPriorityItemIndex(working);
    working.splice(removeIdx, 1);
  }
  working.push({
    category: "stock",
    severity: "watch",
    symbol: candidate.ticker,
    text: requiredText,
  });

  // Safety: never exceed maxItems
  return {
    items: working.slice(0, maxItems),
    inserted: true,
    corrected: false,
    enforcedTicker: candidate.ticker,
  };
}
