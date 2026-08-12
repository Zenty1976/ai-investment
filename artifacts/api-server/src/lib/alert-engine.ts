/**
 * Deterministic Alert Engine
 *
 * Replaces the Market Alerts OpenAI call with a rule-based pipeline.
 * Zero OpenAI calls in normal operation.
 *
 * Pipeline:
 *   1. Extract alert candidates from each source module
 *   2. Deduplicate (same underlying development in multiple modules)
 *   3. Apply severity rules and generate schema-compatible fields
 *   4. Compute overall level, headline, executiveSummary, thingsToWatch
 *
 * Inputs the route must resolve before calling:
 *   - holdingSymbols: portfolio ticker symbols (already uppercased)
 *   - cmEntries:      Map<ticker, raw CM result> — identity-resolved by route
 *   - nowDate:        current UTC date
 *   - repository:     IAlertRepository — read-only access to module results
 *
 * The engine never calls OpenAI.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlertSeverity = "High" | "Medium" | "Low";
export type AlertCategory =
  | "Portfolio" | "Company" | "Macro"
  | "Sector" | "Event" | "Geopolitical" | "Currency";
export type AlertSourceType = "Web" | "NewsMonitor" | "CompanyMonitor" | "EventMonitor";
export type RecommendedAttention = "Monitor" | "Review" | "Prepare" | "Watch";

/** Schema-compatible alert (matches RunMarketAlertsResponse alert shape) */
export interface EngineAlert {
  title: string;
  category: AlertCategory;
  importance: AlertSeverity;
  /** Placeholder — route updates this from status comparison (New/Updated/Unchanged) */
  isNew: boolean;
  requiresAttention: boolean;
  /** Ticker symbols of held positions affected. CRITICAL: TDE uses this for evidence scoring. */
  affectedHoldings: string[];
  summary: string;
  whyItMatters: string;
  recommendedAttention: RecommendedAttention;
  sourceType: AlertSourceType;
}

/** Internal representation carrying dedup metadata */
interface AlertCandidate extends EngineAlert {
  /** Stable key for deduplication, format "source:identifier" */
  dedupeKey: string;
  /** Human-readable explanation for debug — "investmentCaseChange.severity=High" */
  reason: string;
  /** Source module for debug display */
  sourceModule: string;
  /** Lower number = higher authority for dedup resolution */
  sourcePriority: number;
}

export interface AlertEngineDebug {
  aiCalls: 0;
  candidateCount: number;
  finalAlertCount: number;
  sources: {
    companyMonitor: number;
    newsMonitor: number;
    eventMonitor: number;
    marketMonitor: number;
    sectorMonitor: number;
  };
  /** Resolved sector per holding — key: portfolio ticker, value: sector string used for matching */
  resolvedSectors: Record<string, string>;
  candidates: Array<{
    dedupeKey: string;
    sourceModule: string;
    severity: AlertSeverity;
    title: string;
    reason: string;
    kept: boolean;
    discardReason?: string;
  }>;
}

export interface AlertEngineResult {
  overallAlertLevel: AlertSeverity;
  executiveSummary: string;
  headline: string;
  alerts: EngineAlert[];
  thingsToWatch: string[];
  nothingImportantChanged: boolean;
  _engineDebug: AlertEngineDebug;
}

/** Minimal repository interface — allows injecting mocks in tests */
export interface IAlertRepository {
  get<T>(key: string): { result: T; moduleName?: string } | undefined;
  getAll(): Array<{ moduleName: string; result: unknown }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map(String) : [];
}

/** Map severity + portfolio context → recommended attention level */
function recommendedAttentionFor(
  severity: AlertSeverity,
  affectedHoldings: string[]
): RecommendedAttention {
  const isHolding = affectedHoldings.length > 0;
  if (severity === "High")   return isHolding ? "Prepare" : "Review";
  if (severity === "Medium") return isHolding ? "Review"  : "Watch";
  return "Monitor";
}

/**
 * Fuzzy-match tickers against a list of market/sector strings.
 * Returns tickers that appear in any of the market strings.
 * Matches both direct ticker mentions ("AAPL") and sector-based mentions
 * using the holdingSectors map.
 */
function matchHoldings(
  holdingSymbols: string[],
  markets: string[],
  holdingSectors: Map<string, string>
): string[] {
  const lowerMarkets = markets.map((m) => m.toLowerCase());
  return holdingSymbols.filter((ticker) => {
    const t = ticker.toLowerCase();
    if (lowerMarkets.some((m) => m.includes(t))) return true;
    // Sector-based match
    const sector = (holdingSectors.get(ticker) ?? "").toLowerCase();
    if (sector && lowerMarkets.some((m) => m.includes(sector) || sector.includes(m))) return true;
    return false;
  });
}

// ── Extraction: Company Monitor ───────────────────────────────────────────────

function extractCompanyAlerts(
  cmEntries: Map<string, Record<string, unknown>>,
  holdingSectors: Map<string, string>
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];

  for (const [ticker, result] of cmEntries) {
    // Skip entries with no material change
    const updateType = str(result.updateType);
    if (updateType === "NoMaterialChange") continue;

    const caseChange = result.investmentCaseChange as Record<string, unknown> | undefined;
    if (!caseChange?.changed) continue;

    const thesis = Array.isArray(result.investmentThesis)
      ? (result.investmentThesis as Array<Record<string, unknown>>)
      : [];

    const investmentView = result.investmentView as Record<string, unknown> | undefined;
    const rating = str(investmentView?.rating);
    const ccSeverity = str(caseChange.severity);

    const hasInvalidated = thesis.some((t) => t.status === "Invalidated");
    const hasWeakened    = thesis.some((t) => t.status === "Weakened");

    // ── Severity rules ────────────────────────────────────────────────────────
    // HIGH: thesis invalidated, case severity High, or Strong Avoid rating
    // MEDIUM: thesis weakened, case severity Medium, or Avoid rating
    // LOW: any other change
    let severity: AlertSeverity;
    let reason: string;

    if (hasInvalidated || ccSeverity === "High" || rating === "Strong Avoid") {
      severity = "High";
      reason = hasInvalidated
        ? "investmentThesis.status=Invalidated"
        : ccSeverity === "High"
        ? "investmentCaseChange.severity=High"
        : "investmentView.rating=Strong Avoid";
    } else if (hasWeakened || ccSeverity === "Medium" || rating === "Avoid") {
      severity = "Medium";
      reason = hasWeakened
        ? "investmentThesis.status=Weakened"
        : ccSeverity === "Medium"
        ? "investmentCaseChange.severity=Medium"
        : "investmentView.rating=Avoid";
    } else {
      severity = "Low";
      reason = `investmentCaseChange.severity=${ccSeverity}, updateType=${updateType}`;
    }

    const company = result.company as Record<string, unknown> | undefined;
    const companyName = str(company?.name || ticker);
    const sector = str(company?.sector ?? "");
    if (sector) holdingSectors.set(ticker, sector); // update sector map while iterating

    // Populate sector map entry from CM data
    const changeSummary = str(caseChange.summary ?? caseChange.reason ?? "");
    const prevView = str(caseChange.previousInvestmentView ?? "");
    const currView = str(caseChange.currentInvestmentView ?? "");

    const titleLabel = hasInvalidated
      ? "Investment thesis invalidated"
      : severity === "High"
      ? "Investment case significantly weakened"
      : severity === "Medium"
      ? "Investment thesis weakened"
      : "Investment case updated";

    const summaryParts: string[] = [];
    if (changeSummary) summaryParts.push(changeSummary);
    if (prevView && currView && prevView !== currView) {
      summaryParts.push(`Rating: ${prevView} → ${currView}`);
    }
    const summary =
      summaryParts.join(". ") ||
      `${companyName} investment case has changed (case severity: ${ccSeverity}).`;

    const whyItMatters =
      str(caseChange.reason ?? caseChange.summary ?? "") ||
      `${companyName} is a current holding and its investment assessment has ${
        severity === "High" ? "significantly deteriorated" : "changed"
      }.`;

    candidates.push({
      dedupeKey: `company:${ticker}`,
      title: `${ticker}: ${titleLabel}`,
      category: "Company",
      importance: severity,
      isNew: true,
      requiresAttention: severity === "High" || severity === "Medium",
      affectedHoldings: [ticker],
      summary,
      whyItMatters,
      recommendedAttention: recommendedAttentionFor(severity, [ticker]),
      sourceType: "CompanyMonitor",
      reason: `CompanyMonitor.${reason}, holding=true`,
      sourceModule: `company-monitor:${ticker}`,
      sourcePriority: 1, // highest authority for company-specific developments
    });
  }

  return candidates;
}

// ── Extraction: News Monitor ──────────────────────────────────────────────────

function extractNewsAlerts(
  holdingSymbols: string[],
  holdingSectors: Map<string, string>,
  tickersCoveredByCM: Set<string>,
  repo: IAlertRepository
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];

  const entry = repo.get<Record<string, unknown>>("news-monitor");
  if (!entry) return candidates;

  const news = Array.isArray(entry.result.news)
    ? (entry.result.news as Array<Record<string, unknown>>)
    : [];

  for (const item of news) {
    const importance = str(item.importance) as AlertSeverity;
    if (importance === "Low") continue; // skip low-importance news

    const affectedMarkets = strArr(item.affectedMarkets);
    const affectedHoldings = matchHoldings(holdingSymbols, affectedMarkets, holdingSectors);

    // Skip medium news that has no holding relevance
    if (importance === "Medium" && affectedHoldings.length === 0) continue;

    // Skip if all affected holdings are already covered by a higher-priority CM alert
    // (CM is more authoritative for company-specific news)
    // Exception: keep High-importance news even if CM exists (it may be broader)
    if (
      importance !== "High" &&
      affectedHoldings.length > 0 &&
      affectedHoldings.every((t) => tickersCoveredByCM.has(t))
    ) {
      continue;
    }

    const id = str(item.id);
    const title = str(item.title);
    const titleCapped = title.length > 150 ? title.slice(0, 147) + "…" : title;
    const summary = str(item.summary);
    const whyItMatters = str(item.whyItMatters || item.marketImpact);
    const category: AlertCategory = affectedHoldings.length > 0 ? "Company" : "Macro";

    candidates.push({
      dedupeKey: `news:${id}`,
      title: titleCapped,
      category,
      importance,
      isNew: true,
      requiresAttention: importance === "High",
      affectedHoldings,
      summary,
      whyItMatters,
      recommendedAttention: recommendedAttentionFor(importance, affectedHoldings),
      sourceType: "NewsMonitor",
      reason: `NewsMonitor.news[id=${id}].importance=${importance}`,
      sourceModule: "news-monitor",
      sourcePriority: 3,
    });
  }

  return candidates;
}

// ── Extraction: Event Monitor ─────────────────────────────────────────────────

function extractEventAlerts(
  holdingSymbols: string[],
  holdingSectors: Map<string, string>,
  nowDate: Date,
  repo: IAlertRepository
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];

  const entry = repo.get<Record<string, unknown>>("event-monitor");
  if (!entry) return candidates;

  const events = Array.isArray(entry.result.events)
    ? (entry.result.events as Array<Record<string, unknown>>)
    : [];

  for (const ev of events) {
    const importance = str(ev.importance) as AlertSeverity;
    if (importance === "Low") continue;

    const dateStr = str(ev.date);
    const evDate = dateStr ? new Date(dateStr + "T00:00:00Z") : null;
    const daysUntil =
      evDate && !isNaN(evDate.getTime())
        ? Math.ceil((evDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;

    // Only future events (today or later)
    if (daysUntil !== null && daysUntil < 0) continue;

    const affectedMarkets = strArr(ev.affectedMarkets);
    const affectedHoldings = matchHoldings(holdingSymbols, affectedMarkets, holdingSectors);

    // Medium events: only if affecting holdings AND within 14 days
    if (importance === "Medium") {
      if (affectedHoldings.length === 0) continue;
      if (daysUntil !== null && daysUntil > 14) continue;
    }

    // High events: only if within 14 days OR affecting holdings
    if (importance === "High" && daysUntil !== null && daysUntil > 14 && affectedHoldings.length === 0) {
      continue;
    }

    const title = str(ev.title);
    const category = str(ev.category);
    const expectedImpact = str(ev.expectedImpact);
    const reason = str(ev.reason);

    const daysStr =
      daysUntil === null ? ""
      : daysUntil === 0  ? " (today)"
      : daysUntil === 1  ? " (tomorrow)"
      : ` (in ${daysUntil} days)`;

    // requiresAttention: high-importance events within 3 days
    const requiresAttention =
      importance === "High" && (daysUntil === null || daysUntil <= 3);

    const eventSummary = [category ? `${category} event` : "Upcoming event", dateStr ? `on ${dateStr}` : ""].filter(Boolean).join(" ");

    candidates.push({
      dedupeKey: `event:${title}:${dateStr}`,
      title: `${title}${daysStr}`,
      category: "Event",
      importance,
      isNew: true,
      requiresAttention,
      affectedHoldings,
      summary: expectedImpact
        ? `${eventSummary}: ${expectedImpact}`
        : eventSummary,
      whyItMatters: reason || expectedImpact || `${title} is approaching.`,
      recommendedAttention: requiresAttention
        ? recommendedAttentionFor("High", affectedHoldings)
        : recommendedAttentionFor(importance, affectedHoldings),
      sourceType: "EventMonitor",
      reason: `EventMonitor.events[${title}].importance=${importance}, daysUntil=${daysUntil ?? "unknown"}`,
      sourceModule: "event-monitor",
      sourcePriority: 2, // more authoritative than News for scheduled events
    });
  }

  return candidates;
}

// ── Extraction: Market Monitor ────────────────────────────────────────────────

function extractMarketAlert(
  holdingSymbols: string[],
  repo: IAlertRepository
): AlertCandidate | null {
  const entry = repo.get<Record<string, unknown>>("market-monitor");
  if (!entry) return null;

  const r = entry.result;
  const riskLevel  = str(r.riskLevel);
  const sentiment  = str(r.marketSentiment);
  const summary    = str(r.summary).slice(0, 300);
  const keyRisks   = strArr(r.keyRisks);
  const negFactors = strArr(r.negativeFactors);

  // ── Severity rules ────────────────────────────────────────────────────────
  // HIGH: riskLevel=High
  // MEDIUM: riskLevel=Moderate + Negative sentiment
  // Otherwise: not material enough for an alert
  let severity: AlertSeverity;
  let reason: string;

  if (riskLevel === "High") {
    severity = "High";
    reason = "marketMonitor.riskLevel=High";
  } else if (riskLevel === "Moderate" && sentiment === "Negative") {
    severity = "Medium";
    reason = "marketMonitor.riskLevel=Moderate+sentiment=Negative";
  } else {
    return null;
  }

  const whyItMatters = keyRisks[0] ?? negFactors[0] ?? summary;
  const alertSummary =
    summary ||
    `Market conditions show ${sentiment.toLowerCase()} sentiment with ${riskLevel.toLowerCase()} risk level.`;

  return {
    dedupeKey: `market:${riskLevel}:${sentiment}`,
    title: `Market outlook: ${riskLevel} risk, ${sentiment.toLowerCase()} sentiment`,
    category: "Macro",
    importance: severity,
    isNew: true,
    requiresAttention: severity === "High",
    // For HIGH: include all holdings (portfolio-wide concern); for MEDIUM: general macro
    affectedHoldings: severity === "High" ? [...holdingSymbols] : [],
    summary: alertSummary,
    whyItMatters,
    recommendedAttention: severity === "High" ? "Review" : "Watch",
    sourceType: "Web",
    reason,
    sourceModule: "market-monitor",
    sourcePriority: 5, // most general — lowest priority
  };
}

// ── Extraction: Sector Monitor ────────────────────────────────────────────────

function extractSectorAlerts(
  holdingSymbols: string[],
  holdingSectors: Map<string, string>,
  repo: IAlertRepository
): AlertCandidate[] {
  const candidates: AlertCandidate[] = [];

  const entry = repo.get<Record<string, unknown>>("sector-monitor");
  if (!entry) return candidates;

  const sectors = Array.isArray(entry.result.sectors)
    ? (entry.result.sectors as Array<Record<string, unknown>>)
    : [];

  for (const sector of sectors) {
    const rating = str(sector.rating);
    const trend  = str(sector.trend);
    const name   = str(sector.name);

    // ── Severity rules ────────────────────────────────────────────────────────
    // HIGH: Weak + Weakening
    // MEDIUM: Weak (stable) OR Moderately Weak + Weakening
    // Otherwise: skip
    let severity: AlertSeverity;
    let reason: string;

    if (rating === "Weak" && trend === "Weakening") {
      severity = "High";
      reason = `sectorMonitor[${name}].rating=Weak+trend=Weakening`;
    } else if (rating === "Weak" || (rating === "Moderately Weak" && trend === "Weakening")) {
      severity = "Medium";
      reason = `sectorMonitor[${name}].rating=${rating}+trend=${trend}`;
    } else {
      continue;
    }

    // Find holdings in this sector.
    // Direction: holding's sector must CONTAIN the SM sector name.
    // e.g. "Information Technology".includes("Technology") → true
    //      "Technology".includes("Biotechnology")          → false (shorter can never contain longer)
    //      "Technology".includes("AI & Software")          → false
    // We intentionally do NOT check the reverse direction to prevent
    // "biotechnology".includes("technology") = true false positives.
    const sectorLower = name.toLowerCase();
    const affectedHoldings = holdingSymbols.filter((ticker) => {
      const tickerSector = (holdingSectors.get(ticker) ?? "").toLowerCase();
      if (!tickerSector || !sectorLower) return false; // no data → cannot match
      // Exact or containment: holding's sector contains the SM sector name
      return tickerSector.includes(sectorLower);
    });

    // Only include if holdings are affected, OR sector is High severity (broad impact)
    if (affectedHoldings.length === 0 && severity !== "High") continue;

    const sectorSummary = str(sector.summary).slice(0, 300);
    const risks = strArr(sector.risks);
    const whyItMatters =
      risks[0] ||
      `${name} sector is experiencing ${trend.toLowerCase()} conditions with a ${rating.toLowerCase()} rating.`;

    candidates.push({
      dedupeKey: `sector:${name}`,
      title: `${name} sector: ${rating.toLowerCase()} outlook, ${trend.toLowerCase()} trend`,
      category: "Sector",
      importance: severity,
      isNew: true,
      requiresAttention: severity === "High" && affectedHoldings.length > 0,
      affectedHoldings,
      summary:
        sectorSummary ||
        `${name} sector is showing ${rating.toLowerCase()} conditions with a ${trend.toLowerCase()} trend.`,
      whyItMatters,
      recommendedAttention: recommendedAttentionFor(severity, affectedHoldings),
      sourceType: "Web",
      reason,
      sourceModule: "sector-monitor",
      sourcePriority: 4,
    });
  }

  return candidates;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

interface DedupeResult {
  kept: AlertCandidate[];
  discarded: Map<string, string>; // dedupeKey → reason for discard
}

function deduplicateCandidates(candidates: AlertCandidate[]): DedupeResult {
  // Sort by source priority (lower = higher authority)
  const sorted = [...candidates].sort((a, b) => a.sourcePriority - b.sourcePriority);

  const kept: AlertCandidate[] = [];
  const discarded = new Map<string, string>();
  const usedDedupeKeys = new Set<string>();
  // Tickers "claimed" by a higher-priority CM alert
  const tickersCoveredByCM = new Set<string>();

  for (const candidate of sorted) {
    // Exact dedup by key
    if (usedDedupeKeys.has(candidate.dedupeKey)) {
      discarded.set(candidate.dedupeKey, "Duplicate dedupeKey — same development already added");
      continue;
    }

    // News items covering tickers that already have a CM alert:
    // Company Monitor is more authoritative for company-specific developments.
    // Exception: always keep High-importance news (may carry broader context).
    if (
      candidate.sourceType === "NewsMonitor" &&
      candidate.affectedHoldings.length > 0 &&
      candidate.importance !== "High" &&
      candidate.affectedHoldings.every((t) => tickersCoveredByCM.has(t))
    ) {
      discarded.set(
        candidate.dedupeKey,
        `Ticker(s) ${candidate.affectedHoldings.join(",")} already covered by CompanyMonitor`
      );
      continue;
    }

    usedDedupeKeys.add(candidate.dedupeKey);

    if (candidate.sourceType === "CompanyMonitor") {
      for (const ticker of candidate.affectedHoldings) {
        tickersCoveredByCM.add(ticker);
      }
    }

    kept.push(candidate);
  }

  return { kept, discarded };
}

// ── Main Engine ───────────────────────────────────────────────────────────────

export interface AlertEngineInputs {
  /** Portfolio ticker symbols, already uppercased */
  holdingSymbols: string[];
  /**
   * Identity-resolved Company Monitor results: ticker → raw result.
   * The route must resolve these using companyIdentityStore before calling.
   */
  cmEntries: Map<string, Record<string, unknown>>;
  nowDate: Date;
  /** Read-only repository access — inject real or mock */
  repo: IAlertRepository;
}

export function runAlertEngine(inputs: AlertEngineInputs): AlertEngineResult {
  const { holdingSymbols, cmEntries, nowDate, repo } = inputs;

  // Pre-populate sector map from ALL CM entries (not just those with material changes)
  // so sector matching works for every holding that has a Company Monitor result.
  const holdingSectors = new Map<string, string>();
  for (const [ticker, result] of cmEntries) {
    const company = result.company as Record<string, unknown> | undefined;
    const sector = String(company?.sector ?? "").trim();
    if (sector) holdingSectors.set(ticker, sector);
  }

  // ── 1. Extract candidates from each source ────────────────────────────────
  const cmCandidates = extractCompanyAlerts(cmEntries, holdingSectors);
  const tickersCoveredByCM = new Set(cmCandidates.map((c) => c.affectedHoldings).flat());

  const nmCandidates = extractNewsAlerts(holdingSymbols, holdingSectors, tickersCoveredByCM, repo);
  const emCandidates = extractEventAlerts(holdingSymbols, holdingSectors, nowDate, repo);
  const mmCandidate  = extractMarketAlert(holdingSymbols, repo);
  const smCandidates = extractSectorAlerts(holdingSymbols, holdingSectors, repo);

  const allCandidates: AlertCandidate[] = [
    ...cmCandidates,
    ...emCandidates,   // Events before News (EM wins for event-type dedup)
    ...nmCandidates,
    ...smCandidates,
    ...(mmCandidate ? [mmCandidate] : []),
  ];

  // ── 2. Deduplicate ────────────────────────────────────────────────────────
  const { kept, discarded } = deduplicateCandidates(allCandidates);

  // ── 3. Sort: High before Medium before Low; within tier, holdings first ───
  const sorted = kept.sort((a, b) => {
    const sev: Record<AlertSeverity, number> = { High: 0, Medium: 1, Low: 2 };
    const diff = sev[a.importance] - sev[b.importance];
    if (diff !== 0) return diff;
    return b.affectedHoldings.length - a.affectedHoldings.length;
  });

  // ── 4. Build schema-compatible alerts (strip internal fields) ─────────────
  const alerts: EngineAlert[] = sorted.map(
    ({ dedupeKey: _dk, reason: _r, sourceModule: _sm, sourcePriority: _sp, ...alert }) => ({
      ...alert,
      isNew: true, // route will update this from status comparison
    })
  );

  // ── 5. Compute top-level fields ───────────────────────────────────────────

  const hasHighAttention    = alerts.some((a) => a.importance === "High"   && a.requiresAttention);
  const hasMediumAttention  = alerts.some((a) => a.importance === "Medium" && a.requiresAttention);
  const overallAlertLevel: AlertSeverity = hasHighAttention ? "High" : hasMediumAttention ? "Medium" : "Low";

  const nothingImportantChanged = !alerts.some((a) => a.requiresAttention);

  // Headline: highest-severity requiresAttention alert, or a calm state message
  const topAlert = sorted.find((a) => a.requiresAttention);
  const headline = topAlert
    ? topAlert.title
    : "No material developments requiring immediate attention";

  // Executive summary
  const highCount   = alerts.filter((a) => a.importance === "High"   && a.requiresAttention).length;
  const mediumCount = alerts.filter((a) => a.importance === "Medium" && a.requiresAttention).length;
  const watchCount  = alerts.filter((a) => !a.requiresAttention).length;

  let executiveSummary: string;
  if (nothingImportantChanged) {
    executiveSummary =
      `No material changes detected across ${holdingSymbols.length} monitored position${holdingSymbols.length !== 1 ? "s" : ""} and markets.` +
      (watchCount > 0 ? ` ${watchCount} item${watchCount !== 1 ? "s" : ""} to monitor.` : "");
  } else {
    const parts: string[] = [];
    if (highCount   > 0) parts.push(`${highCount} HIGH-priority alert${highCount   !== 1 ? "s" : ""}`);
    if (mediumCount > 0) parts.push(`${mediumCount} MEDIUM-priority alert${mediumCount !== 1 ? "s" : ""}`);
    executiveSummary =
      `${parts.join(" and ")} require${parts.length > 1 ? "" : "s"} attention.` +
      (watchCount > 0 ? ` ${watchCount} additional item${watchCount !== 1 ? "s" : ""} to monitor.` : "");
  }

  // thingsToWatch: non-requiresAttention alerts (max 5)
  const thingsToWatch = sorted
    .filter((a) => !a.requiresAttention)
    .slice(0, 5)
    .map((a) => a.title);

  // ── 6. Build debug output ─────────────────────────────────────────────────
  const _engineDebug: AlertEngineDebug = {
    aiCalls: 0,
    candidateCount: allCandidates.length,
    finalAlertCount: alerts.length,
    sources: {
      companyMonitor: cmCandidates.length,
      newsMonitor:    nmCandidates.length,
      eventMonitor:   emCandidates.length,
      marketMonitor:  mmCandidate ? 1 : 0,
      sectorMonitor:  smCandidates.length,
    },
    resolvedSectors: Object.fromEntries(holdingSectors),
    candidates: allCandidates.map((c) => ({
      dedupeKey:     c.dedupeKey,
      sourceModule:  c.sourceModule,
      severity:      c.importance,
      title:         c.title,
      reason:        c.reason,
      kept:          !discarded.has(c.dedupeKey),
      discardReason: discarded.get(c.dedupeKey),
    })),
  };

  return {
    overallAlertLevel,
    executiveSummary,
    headline,
    alerts,
    thingsToWatch,
    nothingImportantChanged,
    _engineDebug,
  };
}
