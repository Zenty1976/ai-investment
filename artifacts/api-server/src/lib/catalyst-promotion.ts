/**
 * Catalyst → Opportunity Finder Promotion (spec §18)
 *
 * When Catalyst Intelligence identifies a HIGH_INTEREST or CANDIDATE_FOR_TRADE_DECISION
 * company, it can promote it to the Opportunity Finder pipeline.
 *
 * Architecture:
 *   - Catalyst writes compact CatalystPromotion to "catalyst-promotions" key
 *   - Opportunity Finder reads this key and incorporates it into its context
 *   - Promotion does NOT auto-trigger a BUY — it feeds OF for human evaluation
 *   - Trade Decision Engine reads catalyst state as non-actionable context
 *
 * Repository key: "catalyst-promotions"
 */

import { analysisRepository } from "./analysis-repository.js";
import type {
  CatalystPromotion,
  CatalystState,
  CatalystAnalysisResult,
  CatalystFacts,
  TriggerType,
  ScheduledCatalystType,
  CatalystDirection,
} from "./catalyst-types.js";

const PROMOTIONS_KEY = "catalyst-promotions";

// ── Repository helpers ─────────────────────────────────────────────────────────

interface StoredPromotions {
  promotions: CatalystPromotion[];
  lastUpdatedAt: string;
}

export function getAllPromotions(): CatalystPromotion[] {
  const entry = analysisRepository.get<StoredPromotions>(PROMOTIONS_KEY);
  return entry?.result?.promotions ?? [];
}

export function getActivePromotions(): CatalystPromotion[] {
  return getAllPromotions().filter(p => !p.expired);
}

export function getPromotionForTicker(ticker: string): CatalystPromotion | null {
  const all = getAllPromotions();
  return all.find(p => p.ticker.toUpperCase() === ticker.toUpperCase() && !p.expired) ?? null;
}

function savePromotions(promotions: CatalystPromotion[]): void {
  analysisRepository.save(PROMOTIONS_KEY, {
    promotions,
    lastUpdatedAt: new Date().toISOString(),
  });
}

// ── Promotion lifecycle ────────────────────────────────────────────────────────

/**
 * Promote a ticker to Opportunity Finder consideration.
 *
 * Idempotent — if the ticker is already promoted and the analysis hasn't changed
 * materially, the existing promotion is preserved.
 */
export function promoteToOpportunityFinder(
  ticker: string,
  company: string,
  analysis: CatalystAnalysisResult,
  facts: CatalystFacts
): CatalystPromotion {
  const now = new Date().toISOString();
  const existing = getAllPromotions();

  // Build expiry: 7 days after event (PATH A) or 30 days (PATH B)
  const eventDate = facts.event?.eventDate ?? null;
  let expiresAt: string | null = null;
  if (eventDate) {
    const expiry = new Date(eventDate + "T00:00:00Z");
    expiry.setDate(expiry.getDate() + 7);
    expiresAt = expiry.toISOString();
  } else {
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + 30);
    expiresAt = expiry.toISOString();
  }

  const promotion: CatalystPromotion = {
    ticker: ticker.toUpperCase(),
    company,
    promotedAt: now,
    triggerType: analysis.triggerType,
    eventDate: eventDate,
    eventType: facts.event?.eventType
      ? mapEventTypeToCatalystType(facts.event.eventType)
      : null,
    catalystDirection: analysis.catalystDirection as CatalystDirection,
    evidenceConfidence: analysis.evidenceConfidence,
    expectationGap: analysis.expectationGap,
    priceAsymmetry: analysis.priceAsymmetry,
    opportunityState: analysis.opportunityState,
    keySignalIds: analysis.supportingSignalIds.slice(0, 5),
    keyRisks: analysis.invalidationConditions.slice(0, 3),
    thesis: analysis.thesis,
    invalidationConditions: analysis.invalidationConditions,
    acknowledgedAt: null,
    expired: false,
    expiresAt,
  };

  // Replace existing promotion for same ticker
  const filtered = existing.filter(
    p => p.ticker.toUpperCase() !== ticker.toUpperCase()
  );
  const updated = [promotion, ...filtered];

  // Expire stale promotions
  const cleaned = expireStalePromotions(updated, now);

  savePromotions(cleaned);
  return promotion;
}

/**
 * Mark a promotion as acknowledged by the Opportunity Finder.
 */
export function acknowledgePromotion(ticker: string): void {
  const all = getAllPromotions();
  const now = new Date().toISOString();
  const updated = all.map(p => {
    if (p.ticker.toUpperCase() === ticker.toUpperCase() && !p.acknowledgedAt) {
      return { ...p, acknowledgedAt: now };
    }
    return p;
  });
  savePromotions(updated);
}

/**
 * Expire a promotion manually (e.g. event passed, thesis invalidated).
 */
export function expirePromotion(ticker: string): void {
  const all = getAllPromotions();
  const updated = all.map(p => {
    if (p.ticker.toUpperCase() === ticker.toUpperCase()) {
      return { ...p, expired: true };
    }
    return p;
  });
  savePromotions(updated);
}

/**
 * Expire all promotions whose expiresAt is in the past.
 */
function expireStalePromotions(
  promotions: CatalystPromotion[],
  nowIso: string
): CatalystPromotion[] {
  return promotions.map(p => {
    if (!p.expired && p.expiresAt && p.expiresAt < nowIso) {
      return { ...p, expired: true };
    }
    return p;
  });
}

// ── Summary builders ───────────────────────────────────────────────────────────

/**
 * Build a compact single-line summary of a promotion for injection into
 * Opportunity Finder context. Stays under ~120 characters.
 */
export function buildPromotionOneLiner(p: CatalystPromotion): string {
  const event = p.eventType ? `${mapCatalystTypeLabel(p.eventType)} ${p.eventDate ?? "?D"}` : "Emerging Setup";
  return `${p.ticker} (${p.company}): ${p.catalystDirection} | ${event} | ${p.opportunityState} | "${p.thesis.slice(0, 80)}"`;
}

/**
 * Build a compact context block for Opportunity Finder prompt injection.
 * Lists active promotions in priority order (CandidateForTradeDecision first).
 * Stays under ~600 tokens.
 */
export function buildPromotionsContextBlock(): string {
  const active = getActivePromotions();
  if (active.length === 0) return "";

  // Sort by opportunity state priority
  const statePriority: Record<string, number> = {
    CandidateForTradeDecision: 4,
    HighInterest: 3,
    Investigate: 2,
    Monitor: 1,
    NotInteresting: 0,
  };

  const sorted = [...active].sort(
    (a, b) => (statePriority[b.opportunityState] ?? 0) - (statePriority[a.opportunityState] ?? 0)
  );

  const lines = sorted.slice(0, 6).map(p => buildPromotionOneLiner(p));

  return [
    "CATALYST INTELLIGENCE PROMOTIONS (pre-event opportunities identified, in priority order):",
    ...lines,
    "(These are pre-vetted by the Catalyst Intelligence system — consider these as priority candidates)",
  ].join("\n");
}

/**
 * Build a compact TDE context block for a specific ticker.
 * Non-actionable — purely informational for trade decision context.
 */
export function buildCatalystTdeContext(ticker: string): string | null {
  const p = getPromotionForTicker(ticker);
  if (!p) return null;

  const lines = [
    `CATALYST INTELLIGENCE CONTEXT (non-actionable pre-event thesis):`,
    `  Trigger: ${p.triggerType} | Direction: ${p.catalystDirection} | State: ${p.opportunityState}`,
    `  Thesis: ${p.thesis}`,
  ];

  if (p.eventDate) {
    lines.push(`  Event: ${p.eventType ? mapCatalystTypeLabel(p.eventType) : "Scheduled"} on ${p.eventDate}`);
  }

  if (p.keyRisks.length > 0) {
    lines.push(`  Key Risks: ${p.keyRisks.slice(0, 2).join("; ")}`);
  }

  lines.push(`  INTENTIONAL_PRE_EVENT_THESIS: pre-event positioning (requires manual approval)`);

  return lines.join("\n");
}

// ── Type mapping helpers ───────────────────────────────────────────────────────

function mapEventTypeToCatalystType(
  eventType: string | { eventType?: string } | null | undefined
): ScheduledCatalystType | null {
  if (!eventType) return null;
  const t = typeof eventType === "string" ? eventType : eventType?.eventType ?? "";
  // If it already matches a ScheduledCatalystType, return it
  const validTypes: ScheduledCatalystType[] = [
    "EARNINGS", "GUIDANCE_UPDATE", "INVESTOR_DAY", "CAPITAL_MARKETS_DAY",
    "COMPANY_MEETING", "SHAREHOLDER_MEETING", "PRODUCT_LAUNCH", "AI_MODEL_LAUNCH",
    "TECHNOLOGY_DEMONSTRATION", "DEVELOPER_CONFERENCE", "KEYNOTE",
    "CLINICAL_READOUT", "FDA_DECISION", "REGULATORY_DECISION", "COURT_DECISION",
    "MAJOR_CONTRACT_DECISION", "M_AND_A_EVENT", "LOCKUP_EXPIRATION",
    "STRATEGY_UPDATE", "MANAGEMENT_PRESENTATION", "OTHER_COMPANY_CATALYST",
  ];
  if (validTypes.includes(t as ScheduledCatalystType)) return t as ScheduledCatalystType;
  // Map old Part 1 event types
  if (t === "Earnings" || t === "earnings") return "EARNINGS";
  if (t === "GuidanceUpdate") return "GUIDANCE_UPDATE";
  if (t === "CapitalMarketsDay") return "CAPITAL_MARKETS_DAY";
  if (t === "AGM") return "SHAREHOLDER_MEETING";
  if (t === "ProductLaunch") return "PRODUCT_LAUNCH";
  if (t === "RegulatoryDecision") return "REGULATORY_DECISION";
  return "OTHER_COMPANY_CATALYST";
}

function mapCatalystTypeLabel(t: ScheduledCatalystType | null): string {
  if (!t) return "Event";
  const labels: Partial<Record<ScheduledCatalystType, string>> = {
    EARNINGS: "Earnings",
    GUIDANCE_UPDATE: "Guidance Update",
    INVESTOR_DAY: "Investor Day",
    CAPITAL_MARKETS_DAY: "Capital Markets Day",
    FDA_DECISION: "FDA Decision",
    CLINICAL_READOUT: "Clinical Readout",
    PRODUCT_LAUNCH: "Product Launch",
    AI_MODEL_LAUNCH: "AI Model Launch",
    M_AND_A_EVENT: "M&A Event",
    STRATEGY_UPDATE: "Strategy Update",
    REGULATORY_DECISION: "Regulatory Decision",
  };
  return labels[t] ?? t.replace(/_/g, " ");
}
