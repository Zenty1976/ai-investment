/**
 * Trade Decision Outcome Store
 *
 * Collects and maintains structured outcome records for every PrepareToBuy
 * and PrepareToReduce decision that passes backend validation.
 *
 * Purpose: build a clean historical dataset that can later be used to
 * measure whether TDE proposals proved useful (calibration, not ML).
 *
 * Persistence keys:
 *   "trade-decision-outcomes"          — active / recent outcome records
 *   "trade-decision-outcome-history"   — closed / superseded outcome records
 *
 * Design rules:
 *   - No full OpenAI prompts or raw responses are stored here.
 *   - Success measurement must be deterministic and based on market prices.
 *   - OpenAI is never called from this module.
 *   - Automatic weight changes are NOT performed.
 */
import { analysisRepository } from "./analysis-repository.js";
import { systemLog } from "./system-log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionOutcomeStatus =
  | "Tracking"          // created, not yet ready or approved
  | "AwaitingExecution" // approved, waiting for Saxo execution
  | "Rejected"          // user rejected in Trade Review
  | "Expired"           // decision aged out without resolution
  | "Executed"          // Saxo execution confirmed
  | "Closed"            // position closed / returned
  | "InsufficientData"; // could not compute meaningful outcome

export interface DecisionOutcome {
  /** Stable unique record ID: `${ticker}:${decisionType}:v${decisionVersion}` */
  id:               string;
  /** Stable decision ID across versions: `${ticker}:${decisionType}` */
  decisionId:       string;
  /** Integer version, incremented when the decision's fingerprint changes materially. */
  decisionVersion:  number;
  /** Last seen decision fingerprint — used to detect material changes on the next TDE run. */
  lastFingerprint:  string | null;

  // ── Decision metadata ─────────────────────────────────────────────────────
  ticker:           string;
  company:          string;
  subjectType:      "Holding" | "Opportunity" | "Portfolio";
  decisionType:     "PrepareToBuy" | "PrepareToReduce";
  /** Stateful status from TDE at the time this record was created. */
  decisionStatus:   "New" | "Strengthened" | "Weakened" | "Unchanged";
  /** Active policy profile when the decision was created. */
  policyProfile:    string;

  // ── Lifecycle timestamps (ISO 8601) ───────────────────────────────────────
  createdAt:       string;
  becameReadyAt:   string | null;
  approvedAt:      string | null;
  rejectedAt:      string | null;
  executedAt:      string | null;
  closedAt:        string | null;

  // ── Evidence snapshot (captured at creation) ──────────────────────────────
  evidenceScore:   number;
  evidenceBand:    string;
  confidence:      "High" | "Medium" | "Low";
  urgency:         "Immediate" | "Days" | "Weeks" | "NoUrgency";
  targetAllocationPercent: number | null;
  supportingModules: string[];
  opposingModules:   string[];

  // ── Company Monitor snapshot ──────────────────────────────────────────────
  /** investmentCaseStrength at decision time (0–100 or null). */
  companyMonitorStrength:          number | null;
  /** meaningfulChange severity from Company Monitor. */
  companyMonitorCaseChangeSeverity: string | null;

  // ── Portfolio context ─────────────────────────────────────────────────────
  /** Total portfolio value in base currency at time of decision. */
  portfolioValueAtDecision: number | null;

  // ── Reference price (captured when Trade Review produces a proposal) ──────
  referencePrice:          number | null;
  referencePriceCurrency:  string | null;
  referencePriceTimestamp: string | null;

  // ── Execution data (populated when/if Saxo execution is linked) ──────────
  executedPrice:    number | null;
  executedQuantity: number | null;

  // ── Outcome price data (populated by future price capture service) ────────
  outcomePrice1Day:   number | null;
  outcomePrice5Days:  number | null;
  outcomePrice20Days: number | null;

  // ── Derived return metrics (populated after price capture) ────────────────
  outcomeReturn1DayPercent:   number | null;
  outcomeReturn5DaysPercent:  number | null;
  outcomeReturn20DaysPercent: number | null;
  maximumFavourableMovePercent: number | null;
  maximumAdverseMovePercent:    number | null;
  realizedReturnPercent:        number | null;

  // ── Final status ──────────────────────────────────────────────────────────
  outcomeStatus: DecisionOutcomeStatus;
  /** Human-readable note added when status changes. */
  statusNote:    string | null;

  /** ID of the previous version this record supersedes (null for v1). */
  supersededId: string | null;
}

interface OutcomeStore {
  outcomes:  DecisionOutcome[];
  updatedAt: string;
}

interface OutcomeHistoryStore {
  entries:   DecisionOutcome[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const ACTIVE_KEY  = "trade-decision-outcomes";
const HISTORY_KEY = "trade-decision-outcome-history";
const MAX_ACTIVE  = 200;   // keep active records
const MAX_HISTORY = 1000;  // keep closed records for calibration

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function loadActive(): DecisionOutcome[] {
  const entry = analysisRepository.get<OutcomeStore>(ACTIVE_KEY);
  return Array.isArray(entry?.result?.outcomes) ? (entry!.result.outcomes as DecisionOutcome[]) : [];
}

function loadHistory(): DecisionOutcome[] {
  const entry = analysisRepository.get<OutcomeHistoryStore>(HISTORY_KEY);
  return Array.isArray(entry?.result?.entries) ? (entry!.result.entries as DecisionOutcome[]) : [];
}

function saveActive(outcomes: DecisionOutcome[]): void {
  analysisRepository.save(ACTIVE_KEY, {
    outcomes: outcomes.slice(0, MAX_ACTIVE),
    updatedAt: new Date().toISOString(),
  });
}

function appendHistory(closed: DecisionOutcome[]): void {
  if (closed.length === 0) return;
  const history = loadHistory();
  const merged  = [...closed, ...history].slice(0, MAX_HISTORY);
  analysisRepository.save(HISTORY_KEY, {
    entries:   merged,
    updatedAt: new Date().toISOString(),
  });
}

function makeId(decisionId: string, version: number): string {
  return `${decisionId}:v${version}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RecordOutcomeInput {
  decisionId:      string;   // e.g. "AAPL:PrepareToBuy"
  ticker:          string;
  company:         string;
  subjectType:     "Holding" | "Opportunity" | "Portfolio";
  decisionType:    "PrepareToBuy" | "PrepareToReduce";
  decisionStatus:  "New" | "Strengthened" | "Weakened" | "Unchanged";
  policyProfile:   string;
  isReadyForReview: boolean;
  fingerprint:     string;   // used to detect material changes

  evidenceScore:   number;
  evidenceBand:    string;
  confidence:      "High" | "Medium" | "Low";
  urgency:         "Immediate" | "Days" | "Weeks" | "NoUrgency";
  targetAllocationPercent: number | null;
  supportingModules: string[];
  opposingModules:   string[];

  companyMonitorStrength:           number | null;
  companyMonitorCaseChangeSeverity: string | null;
  portfolioValueAtDecision:         number | null;

  referencePrice?:         number | null;
  referencePriceCurrency?: string | null;
}

/**
 * Called by the Trade Decision Engine after every successful analysis.
 *
 * Behaviour:
 * - If no existing record: creates a new v1 record.
 * - If existing record with matching fingerprint: updates timestamps only
 *   (preserves outcome identity — same version).
 * - If existing record with different fingerprint (material change): moves
 *   the old record to history as Expired, creates a new version.
 */
export function recordDecisionOutcome(
  input:           RecordOutcomeInput,
  fingerprintKey:  string   // separate from id — e.g. the decision fingerprint
): DecisionOutcome {
  const now     = new Date().toISOString();
  const active  = loadActive();
  const existing = active.find(o => o.decisionId === input.decisionId);

  // ── Material change: close old, open new ─────────────────────────────────
  if (existing && existing.outcomeStatus === "Tracking" && existing.lastFingerprint !== null && fingerprintKey !== existing.lastFingerprint) {
    // Move old record to history as Expired (decision was superseded)
    const closed: DecisionOutcome = {
      ...existing,
      outcomeStatus: "Expired",
      closedAt:      now,
      statusNote:    `Superseded by version ${existing.decisionVersion + 1}`,
    };
    const withoutOld = active.filter(o => o.id !== existing.id);
    saveActive(withoutOld);
    appendHistory([closed]);

    // Create new version
    const newVersion = existing.decisionVersion + 1;
    const newRecord  = buildNewRecord(input, now, newVersion, existing.id, fingerprintKey);
    saveActive([newRecord, ...withoutOld]);
    systemLog.logInternal("TradeDecisionOutcome", `${input.decisionId}: version ${newVersion} created (previous superseded)`);
    return newRecord;
  }

  // ── Same decision — update metadata only ─────────────────────────────────
  if (existing) {
    const updated: DecisionOutcome = {
      ...existing,
      lastFingerprint:  fingerprintKey,
      decisionStatus:   input.decisionStatus,   // may change: New → Strengthened / Weakened / Unchanged
      policyProfile:    input.policyProfile,     // may change if user switches profile mid-run
      confidence:       input.confidence,
      urgency:          input.urgency,
      evidenceScore:    input.evidenceScore,
      evidenceBand:     input.evidenceBand,
      supportingModules: input.supportingModules,
      opposingModules:   input.opposingModules,
      targetAllocationPercent:          input.targetAllocationPercent,
      companyMonitorStrength:           input.companyMonitorStrength ?? existing.companyMonitorStrength,
      companyMonitorCaseChangeSeverity: input.companyMonitorCaseChangeSeverity ?? existing.companyMonitorCaseChangeSeverity,
      portfolioValueAtDecision:         input.portfolioValueAtDecision ?? existing.portfolioValueAtDecision,
      becameReadyAt: input.isReadyForReview && !existing.becameReadyAt ? now : existing.becameReadyAt,
      outcomeStatus: resolveStatus(existing, input.isReadyForReview),
    };
    saveActive(active.map(o => o.id === updated.id ? updated : o));
    return updated;
  }

  // ── New decision — create v1 ──────────────────────────────────────────────
  const newRecord = buildNewRecord(input, now, 1, null, fingerprintKey);
  saveActive([newRecord, ...active]);
  systemLog.logInternal("TradeDecisionOutcome", `${input.decisionId}: v1 created (${input.decisionStatus})`);
  return newRecord;
}

function buildNewRecord(
  input:        RecordOutcomeInput,
  now:          string,
  version:      number,
  supersededId: string | null,
  fingerprint:  string
): DecisionOutcome {
  return {
    id:              makeId(input.decisionId, version),
    decisionId:      input.decisionId,
    decisionVersion: version,
    lastFingerprint: fingerprint,
    ticker:          input.ticker,
    company:         input.company,
    subjectType:     input.subjectType,
    decisionType:    input.decisionType,
    decisionStatus:  input.decisionStatus,
    policyProfile:   input.policyProfile,

    createdAt:     now,
    becameReadyAt: input.isReadyForReview ? now : null,
    approvedAt:    null,
    rejectedAt:    null,
    executedAt:    null,
    closedAt:      null,

    evidenceScore:   input.evidenceScore,
    evidenceBand:    input.evidenceBand,
    confidence:      input.confidence,
    urgency:         input.urgency,
    targetAllocationPercent: input.targetAllocationPercent ?? null,
    supportingModules: input.supportingModules,
    opposingModules:   input.opposingModules,

    companyMonitorStrength:           input.companyMonitorStrength,
    companyMonitorCaseChangeSeverity: input.companyMonitorCaseChangeSeverity,
    portfolioValueAtDecision:         input.portfolioValueAtDecision,

    referencePrice:          input.referencePrice ?? null,
    referencePriceCurrency:  input.referencePriceCurrency ?? null,
    referencePriceTimestamp: input.referencePrice != null ? now : null,

    executedPrice:    null,
    executedQuantity: null,

    outcomePrice1Day:   null,
    outcomePrice5Days:  null,
    outcomePrice20Days: null,

    outcomeReturn1DayPercent:     null,
    outcomeReturn5DaysPercent:    null,
    outcomeReturn20DaysPercent:   null,
    maximumFavourableMovePercent: null,
    maximumAdverseMovePercent:    null,
    realizedReturnPercent:        null,

    outcomeStatus: input.isReadyForReview ? "Tracking" : "Tracking",
    statusNote:    null,
    supersededId,
  };
}

function resolveStatus(
  existing:       DecisionOutcome,
  isReadyForReview: boolean
): DecisionOutcomeStatus {
  // Once a terminal status is set, do not regress
  const terminal: DecisionOutcomeStatus[] = ["Rejected", "Executed", "Closed", "AwaitingExecution"];
  if ((terminal as string[]).includes(existing.outcomeStatus)) return existing.outcomeStatus;
  return "Tracking";
}

// ---------------------------------------------------------------------------
// Update on Trade Review PATCH
// ---------------------------------------------------------------------------

export interface UpdateOutcomeInput {
  decisionId:       string;
  newStatus:        "Approved" | "Rejected" | "Superseded";
  quantity?:        number;
  estimatedPrice?:  number;
  currency?:        string;
  note?:            string;
}

/**
 * Called by Trade Review when a proposal status changes.
 */
export function updateDecisionOutcomeFromReview(input: UpdateOutcomeInput): void {
  const now    = new Date().toISOString();
  const active = loadActive();
  const idx    = active.findIndex(o => o.decisionId === input.decisionId && o.outcomeStatus === "Tracking");
  if (idx === -1) return; // no active tracking record — nothing to update

  const existing = active[idx];
  let updated: DecisionOutcome;

  if (input.newStatus === "Approved") {
    updated = {
      ...existing,
      approvedAt:      now,
      outcomeStatus:   "AwaitingExecution",
      statusNote:      input.note ?? "Approved in Trade Review",
      referencePrice:  input.estimatedPrice ?? existing.referencePrice,
      referencePriceCurrency: input.currency ?? existing.referencePriceCurrency,
      referencePriceTimestamp: input.estimatedPrice != null ? now : existing.referencePriceTimestamp,
    };
  } else if (input.newStatus === "Rejected") {
    updated = {
      ...existing,
      rejectedAt:    now,
      outcomeStatus: "Rejected",
      statusNote:    input.note ?? "Rejected in Trade Review",
    };
    // Move rejected records to history
    const without = active.filter(o => o.id !== existing.id);
    saveActive(without);
    appendHistory([updated]);
    systemLog.logInternal("TradeDecisionOutcome", `${input.decisionId}: rejected — moved to history`);
    return;
  } else {
    // Superseded
    updated = {
      ...existing,
      closedAt:      now,
      outcomeStatus: "Expired",
      statusNote:    input.note ?? "Superseded",
    };
    const without = active.filter(o => o.id !== existing.id);
    saveActive(without);
    appendHistory([updated]);
    return;
  }

  const newActive = [...active];
  newActive[idx]  = updated;
  saveActive(newActive);
  systemLog.logInternal("TradeDecisionOutcome", `${input.decisionId}: status → ${updated.outcomeStatus}`);
}

// ---------------------------------------------------------------------------
// Price capture (future price data — deterministic, no AI)
// ---------------------------------------------------------------------------

/**
 * Stores the reference price at time of decision (called from TDE or Trade Review).
 */
export function captureReferencePrice(
  decisionId: string,
  price:      number,
  currency:   string
): void {
  const now    = new Date().toISOString();
  const active = loadActive();
  const idx    = active.findIndex(o => o.decisionId === decisionId);
  if (idx === -1) return;

  const updated: DecisionOutcome = {
    ...active[idx],
    referencePrice:          price,
    referencePriceCurrency:  currency,
    referencePriceTimestamp: now,
  };
  const newActive = [...active];
  newActive[idx]  = updated;
  saveActive(newActive);
}

/**
 * Stores a future market price reading for the specified horizon.
 * Also computes the return percent if a reference price is available.
 *
 * @param horizon - "1d" | "5d" | "20d"
 */
export function captureFuturePrice(
  decisionId: string,
  horizon:    "1d" | "5d" | "20d",
  price:      number
): void {
  const active = loadActive();
  const idx    = active.findIndex(o => o.decisionId === decisionId);
  if (idx === -1) return;

  const record = active[idx];
  const ref    = record.referencePrice;

  const returnPct =
    ref != null && ref > 0
      ? Math.round(((price - ref) / ref) * 10000) / 100
      : null;

  // Flip sign for PrepareToReduce (selling is beneficial when price falls)
  const directedReturn =
    returnPct !== null && record.decisionType === "PrepareToReduce"
      ? -returnPct
      : returnPct;

  const patch: Partial<DecisionOutcome> =
    horizon === "1d"  ? { outcomePrice1Day:   price, outcomeReturn1DayPercent:   directedReturn } :
    horizon === "5d"  ? { outcomePrice5Days:  price, outcomeReturn5DaysPercent:  directedReturn } :
                        { outcomePrice20Days: price, outcomeReturn20DaysPercent: directedReturn };

  const newActive = [...active];
  newActive[idx]  = { ...record, ...patch };
  saveActive(newActive);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getOutcomeForDecision(decisionId: string): DecisionOutcome | null {
  const active = loadActive();
  return active.find(o => o.decisionId === decisionId) ?? null;
}

export function getAllActiveOutcomes(): DecisionOutcome[] {
  return loadActive();
}

export function getOutcomeHistory(): DecisionOutcome[] {
  return loadHistory();
}

// ---------------------------------------------------------------------------
// Calibration reporting (backend-only — no UI yet)
// ---------------------------------------------------------------------------

export interface OutcomeStats {
  totalRecords:          number;
  byEvidenceBand:        Record<string, { count: number; avgReturn5d: number | null }>;
  byConfidence:          Record<string, { count: number; avgReturn5d: number | null }>;
  byPolicyProfile:       Record<string, { count: number; avgReturn5d: number | null }>;
  bySupportingModules:   Record<string, { count: number; avgReturn5d: number | null }>;
  readyForReviewCount:   number;
  approvedCount:         number;
  rejectedCount:         number;
  pctRejectedOfReady:    number | null;
  avgMaxFavourableMove:  number | null;
  avgMaxAdverseMove:     number | null;
}

function avgOf(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((s, v) => s + v, 0) / valid.length) * 100) / 100;
}

/**
 * Aggregates outcome statistics for future calibration.
 * Operates only on closed/historical records (active records may lack outcome prices).
 *
 * No automatic weight changes are performed from these results.
 */
export function aggregateOutcomeStats(): OutcomeStats {
  const history = loadHistory();
  const active  = loadActive();
  const all     = [...history, ...active];

  const byBand: Record<string, DecisionOutcome[]> = {};
  const byConf: Record<string, DecisionOutcome[]> = {};
  const byProf: Record<string, DecisionOutcome[]> = {};
  const byMods: Record<string, DecisionOutcome[]> = {};

  for (const r of all) {
    (byBand[r.evidenceBand]    ??= []).push(r);
    (byConf[r.confidence]      ??= []).push(r);
    (byProf[r.policyProfile]   ??= []).push(r);

    const modKey = [...r.supportingModules].sort().join("+") || "none";
    (byMods[modKey] ??= []).push(r);
  }

  const summarize = (groups: Record<string, DecisionOutcome[]>) =>
    Object.fromEntries(
      Object.entries(groups).map(([k, recs]) => [
        k,
        {
          count:       recs.length,
          avgReturn5d: avgOf(recs.map(r => r.outcomeReturn5DaysPercent)),
        },
      ])
    );

  const readyCount    = all.filter(r => r.becameReadyAt !== null).length;
  const approvedCount = all.filter(r => r.approvedAt  !== null).length;
  const rejectedCount = all.filter(r => r.rejectedAt  !== null).length;

  return {
    totalRecords:       all.length,
    byEvidenceBand:     summarize(byBand),
    byConfidence:       summarize(byConf),
    byPolicyProfile:    summarize(byProf),
    bySupportingModules: summarize(byMods),
    readyForReviewCount:  readyCount,
    approvedCount,
    rejectedCount,
    pctRejectedOfReady:  readyCount > 0 ? Math.round((rejectedCount / readyCount) * 1000) / 10 : null,
    avgMaxFavourableMove: avgOf(all.map(r => r.maximumFavourableMovePercent)),
    avgMaxAdverseMove:    avgOf(all.map(r => r.maximumAdverseMovePercent)),
  };
}
