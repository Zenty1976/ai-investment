/**
 * Trade Decision Outcome Store
 *
 * Collects and maintains structured outcome records for every PrepareToBuy
 * and PrepareToReduce decision that passes backend validation.
 *
 * Purpose: build a clean historical dataset that can later be used to
 * measure whether TDE proposals proved useful (calibration, not ML).
 *
 * Identity model:
 *   - subjectDecisionId: stable across decision-type changes.
 *     Format: "${subjectType}:${ticker}" — e.g. "Holding:AAPL", "Opportunity:CAT".
 *   - decisionType is versioned metadata — changing from PrepareToBuy to
 *     PrepareToReduce closes the old version and opens a new one under the
 *     same subjectDecisionId.
 *   - id: "${subjectDecisionId}:v${decisionVersion}" — immutable per version.
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
  | "Tracking"          // created, not yet approved
  | "AwaitingExecution" // approved, waiting for Saxo execution
  | "Rejected"          // user rejected in Trade Review
  | "Expired"           // decision aged out / superseded without resolution
  | "Executed"          // Saxo execution confirmed
  | "Closed"            // position closed / returned
  | "InsufficientData"; // could not compute meaningful outcome

export interface DecisionOutcome {
  /**
   * Immutable record ID: "${subjectDecisionId}:v${decisionVersion}"
   * e.g. "Holding:AAPL:v1", "Opportunity:CAT:v2"
   */
  id:                string;
  /**
   * Stable subject identity across decision-type changes.
   * Format: "${subjectType}:${ticker}" — e.g. "Holding:AAPL".
   * Changing from PrepareToBuy to PrepareToReduce yields a new version
   * under the same subjectDecisionId.
   */
  subjectDecisionId: string;
  /** Integer version, incremented when the decision's fingerprint changes materially. */
  decisionVersion:  number;
  /** Last seen decision fingerprint — used to detect material changes on the next TDE run. */
  lastFingerprint:  string | null;

  // ── Decision metadata ─────────────────────────────────────────────────────
  ticker:           string;
  company:          string;
  subjectType:      "Holding" | "Opportunity" | "Portfolio";
  decisionType:     "PrepareToBuy" | "PrepareToReduce";
  /** Stateful status from TDE at the time this record was created or updated. */
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

  // ── Deferral tracking ─────────────────────────────────────────────────────
  /** Timestamp of first "Later" action on this version (null if never deferred). */
  deferredAt:      string | null;
  /** Number of times "Later" has been chosen for this version. */
  deferredCount:   number;
  /** Timestamp of the most recent "Later" action (same as deferredAt when count = 1). */
  lastDeferredAt:  string | null;

  // ── Evidence snapshot (captured at creation / latest update) ─────────────
  evidenceScore:   number;
  evidenceBand:    string;
  confidence:      "High" | "Medium" | "Low";
  urgency:         "Immediate" | "Days" | "Weeks" | "NoUrgency";
  targetAllocationPercent: number | null;
  supportingModules: string[];
  opposingModules:   string[];

  // ── Company Monitor snapshot ──────────────────────────────────────────────
  /** investmentCaseStrength at decision time (0–100 or null). */
  companyMonitorStrength:           number | null;
  /** meaningfulChange severity from Company Monitor. */
  companyMonitorCaseChangeSeverity: string | null;

  // ── Portfolio context ─────────────────────────────────────────────────────
  /** Total portfolio value in base currency at time of decision. */
  portfolioValueAtDecision: number | null;

  // ── Reference price (captured when Trade Review produces a proposal) ──────
  referencePrice:          number | null;
  referencePriceCurrency:  string | null;
  referencePriceTimestamp: string | null;

  // ── Approval data (populated when user approves in Trade Review) ──────────
  /**
   * The user-adjusted quantity approved in Trade Review.
   * Distinct from executedQuantity — the order may be sized differently at execution.
   */
  approvedQuantity: number | null;

  // ── Execution data (populated when/if Saxo execution is linked) ──────────
  executedPrice:    number | null;
  executedQuantity: number | null;

  // ── Outcome price data (populated by future price capture service) ────────
  outcomePrice1Day:   number | null;
  outcomePrice5Days:  number | null;
  outcomePrice20Days: number | null;

  // ── Derived return metrics (populated after price capture) ────────────────
  outcomeReturn1DayPercent:     number | null;
  outcomeReturn5DaysPercent:    number | null;
  outcomeReturn20DaysPercent:   number | null;
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

/**
 * Normalise a raw record loaded from JSON. Handles:
 *   - Legacy records that used "decisionId" instead of "subjectDecisionId"
 *   - Missing new fields (added as defaults)
 */
function normalizeRecord(raw: unknown): DecisionOutcome {
  const r = raw as Record<string, unknown>;
  // Legacy field migration: decisionId → subjectDecisionId
  if (!r.subjectDecisionId && r.decisionId) {
    r.subjectDecisionId = r.decisionId;
  }
  // Defaults for fields added after initial deployment
  r.deferredAt     = r.deferredAt     ?? null;
  r.deferredCount  = typeof r.deferredCount === "number" ? r.deferredCount : 0;
  r.lastDeferredAt = r.lastDeferredAt ?? null;
  r.approvedQuantity = r.approvedQuantity ?? null;
  return r as unknown as DecisionOutcome;
}

function loadActive(): DecisionOutcome[] {
  const entry = analysisRepository.get<OutcomeStore>(ACTIVE_KEY);
  if (!Array.isArray(entry?.result?.outcomes)) return [];
  return (entry!.result.outcomes as unknown[]).map(normalizeRecord);
}

function loadHistory(): DecisionOutcome[] {
  const entry = analysisRepository.get<OutcomeHistoryStore>(HISTORY_KEY);
  if (!Array.isArray(entry?.result?.entries)) return [];
  return (entry!.result.entries as unknown[]).map(normalizeRecord);
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

function makeId(subjectDecisionId: string, version: number): string {
  return `${subjectDecisionId}:v${version}`;
}

/** Returns true if this record is in a terminal status that must not be modified. */
function isTerminal(r: DecisionOutcome): boolean {
  return ["Rejected", "Executed", "Closed", "Expired"].includes(r.outcomeStatus);
}

// ---------------------------------------------------------------------------
// Public API — record from TDE
// ---------------------------------------------------------------------------

export interface RecordOutcomeInput {
  /**
   * Stable subject identity: "${subjectType}:${ticker}"
   * e.g. "Holding:AAPL", "Opportunity:CAT"
   */
  subjectDecisionId: string;
  ticker:            string;
  company:           string;
  subjectType:       "Holding" | "Opportunity" | "Portfolio";
  decisionType:      "PrepareToBuy" | "PrepareToReduce";
  decisionStatus:    "New" | "Strengthened" | "Weakened" | "Unchanged";
  policyProfile:     string;
  isReadyForReview:  boolean;
  fingerprint:       string;   // used to detect material changes

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
 * - If existing record with matching fingerprint and same decisionType:
 *   updates metadata only (preserves outcome identity — same version).
 * - If existing record with different fingerprint OR different decisionType:
 *   closes the old version as Expired, opens a new version.
 */
export function recordDecisionOutcome(
  input:          RecordOutcomeInput,
  fingerprintKey: string
): DecisionOutcome {
  const now    = new Date().toISOString();
  const active = loadActive();
  const existing = active.find(o => o.subjectDecisionId === input.subjectDecisionId);

  // ── Material change: close old, open new ─────────────────────────────────
  const fingerprintChanged = existing &&
    existing.lastFingerprint !== null &&
    fingerprintKey !== existing.lastFingerprint;
  const typeChanged = existing && existing.decisionType !== input.decisionType;

  if (existing && !isTerminal(existing) && (fingerprintChanged || typeChanged)) {
    const closeNote = typeChanged
      ? `Decision type changed: ${existing.decisionType} → ${input.decisionType} (v${existing.decisionVersion + 1})`
      : `Superseded by version ${existing.decisionVersion + 1}`;
    const closed: DecisionOutcome = {
      ...existing,
      outcomeStatus: "Expired",
      closedAt:      now,
      statusNote:    closeNote,
    };
    const withoutOld = active.filter(o => o.id !== existing.id);
    saveActive(withoutOld);
    appendHistory([closed]);

    const newVersion = existing.decisionVersion + 1;
    const newRecord  = buildNewRecord(input, now, newVersion, existing.id, fingerprintKey);
    saveActive([newRecord, ...withoutOld]);
    systemLog.logInternal(
      "TradeDecisionOutcome",
      `${input.subjectDecisionId}: v${newVersion} created (${typeChanged ? "type changed" : "fingerprint changed"})`
    );
    return newRecord;
  }

  // ── Same decision — update metadata only ─────────────────────────────────
  if (existing && !isTerminal(existing)) {
    const updated: DecisionOutcome = {
      ...existing,
      lastFingerprint:  fingerprintKey,
      decisionType:     input.decisionType,
      decisionStatus:   input.decisionStatus,
      policyProfile:    input.policyProfile,
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
      outcomeStatus: resolveStatus(existing),
    };
    saveActive(active.map(o => o.id === updated.id ? updated : o));
    return updated;
  }

  // ── New decision — create v1 ──────────────────────────────────────────────
  const newRecord = buildNewRecord(input, now, 1, null, fingerprintKey);
  saveActive([newRecord, ...active]);
  systemLog.logInternal(
    "TradeDecisionOutcome",
    `${input.subjectDecisionId}: v1 created (${input.decisionStatus})`
  );
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
    id:                makeId(input.subjectDecisionId, version),
    subjectDecisionId: input.subjectDecisionId,
    decisionVersion:   version,
    lastFingerprint:   fingerprint,
    ticker:            input.ticker,
    company:           input.company,
    subjectType:       input.subjectType,
    decisionType:      input.decisionType,
    decisionStatus:    input.decisionStatus,
    policyProfile:     input.policyProfile,

    createdAt:     now,
    becameReadyAt: input.isReadyForReview ? now : null,
    approvedAt:    null,
    rejectedAt:    null,
    executedAt:    null,
    closedAt:      null,

    deferredAt:     null,
    deferredCount:  0,
    lastDeferredAt: null,

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

    approvedQuantity: null,
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

    outcomeStatus: "Tracking",
    statusNote:    null,
    supersededId,
  };
}

/**
 * Preserves a terminal status; returns "Tracking" for all non-terminal states.
 * ReadyForReview is communicated via becameReadyAt — no separate status needed.
 */
function resolveStatus(existing: DecisionOutcome): DecisionOutcomeStatus {
  if (isTerminal(existing) || existing.outcomeStatus === "AwaitingExecution" || existing.outcomeStatus === "Executed") {
    return existing.outcomeStatus;
  }
  return "Tracking";
}

// ---------------------------------------------------------------------------
// Update on Trade Review PATCH
// ---------------------------------------------------------------------------

export interface UpdateOutcomeInput {
  /**
   * Exact DecisionOutcome.id to update — e.g. "Holding:AAPL:v2".
   * Using the exact record ID prevents accidentally updating an older version
   * when multiple versions exist for the same subject.
   */
  outcomeId:        string;
  newStatus:        "Approved" | "Rejected" | "Superseded" | "Deferred";
  /** Quantity approved by the user (stored as approvedQuantity on Approved). */
  quantity?:        number;
  estimatedPrice?:  number;
  currency?:        string;
  note?:            string;
}

/**
 * Called by Trade Review when a proposal status changes.
 *
 * Uses the exact outcomeId — never matches by ticker/type alone — so the
 * correct version is always updated even when multiple versions exist.
 *
 * Terminal records (Rejected, Expired, Executed, Closed) cannot be
 * modified; if the record is already terminal the call is a no-op.
 */
export function updateDecisionOutcomeFromReview(input: UpdateOutcomeInput): void {
  const now    = new Date().toISOString();
  const active = loadActive();
  const idx    = active.findIndex(o => o.id === input.outcomeId);
  if (idx === -1) return; // record not found — nothing to update

  const existing = active[idx];

  // Terminal records may not be modified
  if (isTerminal(existing)) return;

  if (input.newStatus === "Deferred") {
    // Later action: stay Tracking, increment deferral counters
    const updated: DecisionOutcome = {
      ...existing,
      deferredAt:     existing.deferredAt ?? now,
      deferredCount:  existing.deferredCount + 1,
      lastDeferredAt: now,
    };
    const newActive = [...active];
    newActive[idx]  = updated;
    saveActive(newActive);
    systemLog.logInternal(
      "TradeDecisionOutcome",
      `${existing.subjectDecisionId} v${existing.decisionVersion}: deferred (count=${updated.deferredCount})`
    );
    return;
  }

  let updated: DecisionOutcome;

  if (input.newStatus === "Approved") {
    updated = {
      ...existing,
      approvedAt:      now,
      approvedQuantity: input.quantity ?? existing.approvedQuantity,
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
    // Rejected records move to history immediately
    const without = active.filter(o => o.id !== existing.id);
    saveActive(without);
    appendHistory([updated]);
    systemLog.logInternal(
      "TradeDecisionOutcome",
      `${existing.subjectDecisionId} v${existing.decisionVersion}: rejected — moved to history`
    );
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
  systemLog.logInternal(
    "TradeDecisionOutcome",
    `${existing.subjectDecisionId} v${existing.decisionVersion}: status → ${updated.outcomeStatus}`
  );
}

// ---------------------------------------------------------------------------
// Price capture (future price data — deterministic, no AI)
// ---------------------------------------------------------------------------

/**
 * Stores the reference price at time of decision (called from TDE or Trade Review).
 */
export function captureReferencePrice(
  subjectDecisionId: string,
  price:             number,
  currency:          string
): void {
  const now    = new Date().toISOString();
  const active = loadActive();
  const idx    = active.findIndex(o => o.subjectDecisionId === subjectDecisionId);
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
  subjectDecisionId: string,
  horizon:           "1d" | "5d" | "20d",
  price:             number
): void {
  const active = loadActive();
  const idx    = active.findIndex(o => o.subjectDecisionId === subjectDecisionId);
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

export function getOutcomeForDecision(subjectDecisionId: string): DecisionOutcome | null {
  const active = loadActive();
  return active.find(o => o.subjectDecisionId === subjectDecisionId) ?? null;
}

export function getOutcomeById(outcomeId: string): DecisionOutcome | null {
  const active = loadActive();
  return active.find(o => o.id === outcomeId) ?? null;
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
  deferredCount:         number;
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
 * Operates on all records (history + active).
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
    (byBand[r.evidenceBand]  ??= []).push(r);
    (byConf[r.confidence]    ??= []).push(r);
    (byProf[r.policyProfile] ??= []).push(r);

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
  const approvedCount = all.filter(r => r.approvedAt    !== null).length;
  const rejectedCount = all.filter(r => r.rejectedAt    !== null).length;
  const deferredCount = all.filter(r => r.deferredCount  > 0).length;

  return {
    totalRecords:        all.length,
    byEvidenceBand:      summarize(byBand),
    byConfidence:        summarize(byConf),
    byPolicyProfile:     summarize(byProf),
    bySupportingModules: summarize(byMods),
    readyForReviewCount:  readyCount,
    approvedCount,
    rejectedCount,
    deferredCount,
    pctRejectedOfReady:  readyCount > 0 ? Math.round((rejectedCount / readyCount) * 1000) / 10 : null,
    avgMaxFavourableMove: avgOf(all.map(r => r.maximumFavourableMovePercent)),
    avgMaxAdverseMove:    avgOf(all.map(r => r.maximumAdverseMovePercent)),
  };
}
