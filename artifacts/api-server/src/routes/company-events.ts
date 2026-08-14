/**
 * Company Events Route (spec §3, §4)
 *
 * Endpoints for discovering and retrieving company-specific catalyst events.
 * These are distinct from market-wide EventRecord entries.
 *
 * Endpoints:
 *   GET  /api/company-events/upcoming           — all upcoming events (all tickers)
 *   GET  /api/company-events/:ticker            — stored events for a specific ticker
 *   POST /api/company-events/discover/:ticker   — discover upcoming events via web search
 */

import { Router } from "express";
import { callAiWithWebSearch } from "../lib/ai-service.js";
import { getModel } from "../lib/ai-model-config.js";
import {
  getCompanyEvents, saveCompanyEvents, getAllUpcomingCompanyEvents,
  buildEventId, mergeCompanyEvent, classifyEventType, eventTypeImpact, daysUntilEventDate,
} from "../lib/catalyst-company-events.js";
import type { CompanySpecificEvent, ScheduledCatalystType } from "../lib/catalyst-types.js";

const router = Router();
const MODULE = "company-events";

// ── GET /api/company-events/upcoming ─────────────────────────────────────────

router.get("/company-events/upcoming", (_req, res) => {
  const upcoming = getAllUpcomingCompanyEvents();
  const now = new Date().toISOString().slice(0, 10);

  const withDays = upcoming.map(ev => ({
    ...ev,
    daysUntil: daysUntilEventDate(ev.eventDate),
  }));

  // Group by high-impact events first
  const sorted = [...withDays].sort((a, b) => {
    const impactOrder: Record<string, number> = { High: 3, Medium: 2, Low: 1, Unknown: 0 };
    const impA = impactOrder[a.potentialMarketImpact] ?? 0;
    const impB = impactOrder[b.potentialMarketImpact] ?? 0;
    if (impA !== impB) return impB - impA;
    return a.daysUntil - b.daysUntil;
  });

  res.status(200).json({
    ok: true,
    count: sorted.length,
    today: now,
    events: sorted,
    _debug: { module: MODULE },
  });
});

// ── GET /api/company-events/:ticker ──────────────────────────────────────────

router.get("/company-events/:ticker", (req, res) => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const events = getCompanyEvents(ticker);
  const now = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter(ev => ev.eventDate >= now);
  const past     = events.filter(ev => ev.eventDate <  now);

  res.status(200).json({
    ok: true,
    ticker,
    upcoming,
    past,
    total: events.length,
    _debug: { module: MODULE },
  });
});

// ── POST /api/company-events/discover/:ticker ─────────────────────────────────

const DISCOVERY_SYSTEM_PROMPT = `You are a financial events research assistant. Your task is to find upcoming, scheduled company-specific events that could move the stock price of a given company in the next 3 months.

Focus on finding:
- Earnings/results dates
- Investor Days, Capital Markets Days
- FDA decisions, PDUFA dates (biotech/pharma)
- Major product launches or announcements with a known date
- Clinical trial readouts with expected dates
- Shareholder meetings (if within 3 months)
- Management presentations at investor conferences
- Strategy updates or restructuring announcements

RULES:
- Only include events with a specific date (YYYY-MM-DD) or a narrow date window
- NEVER include events that have already passed
- isConfirmed = true only for officially announced events (company press release, official calendar)
- isConfirmed = false for expected/rumored dates (analyst estimates, historical patterns)
- Include potentialMarketImpact: "High" for earnings/FDA/investor day, "Medium" for product launches/conference presentations, "Low" for routine meetings

OUTPUT: strict JSON array of events (empty array [] if no events found):
[{
  "eventType": "EARNINGS|GUIDANCE_UPDATE|INVESTOR_DAY|CAPITAL_MARKETS_DAY|PRODUCT_LAUNCH|AI_MODEL_LAUNCH|CLINICAL_READOUT|FDA_DECISION|REGULATORY_DECISION|STRATEGY_UPDATE|SHAREHOLDER_MEETING|DEVELOPER_CONFERENCE|KEYNOTE|OTHER_COMPANY_CATALYST",
  "title": "Brief event title",
  "eventDate": "YYYY-MM-DD",
  "eventTime": null,
  "beforeAfterMarket": "BeforeMarket|AfterMarket|DuringMarket|Unknown",
  "isConfirmed": true,
  "expectedTopics": ["topic 1", "topic 2"],
  "potentialMarketImpact": "High|Medium|Low|Unknown",
  "uncertainty": "High|Medium|Low",
  "source": "Source name or URL",
  "sourceType": "DirectCompany|ReliableReporting|AnalystData|AiInterpretation"
}]`;

router.post("/company-events/discover/:ticker", async (req, res): Promise<void> => {
  const ticker = req.params.ticker?.trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ ok: false, error: "Missing ticker" });
    return;
  }

  const company = (req.body?.company as string | undefined)?.trim() ?? ticker;
  const maxDaysAhead = Number(req.body?.maxDaysAhead ?? 90);

  try {
    const userPrompt = `Find all upcoming company-specific events for ${company} (ticker: ${ticker}) in the next ${maxDaysAhead} days.

Search for: earnings dates, investor days, FDA decisions, product launches, clinical readouts, major conferences, strategy updates.

Company: ${company}
Ticker: ${ticker}
Return strict JSON array (can be empty []).`;

    const { result: raw, debug } = await callAiWithWebSearch<unknown[]>(
      DISCOVERY_SYSTEM_PROMPT, userPrompt,
      {
        model: getModel("discovery", "company-events"),
        maxTokens: 1500,
        temperature: 0.1,
        jsonMode: false,
        module: "company-events",
        operation: "discover",
        retryNumber: 0,
        webSearchContextSize: "medium",
      }
    );

    // Parse and validate discovered events
    const discovered: CompanySpecificEvent[] = [];
    const rawArray = Array.isArray(raw) ? raw : [];
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    for (const item of rawArray) {
      if (!item || typeof item !== "object") continue;
      const ev = item as Record<string, unknown>;

      const eventDateRaw = String(ev["eventDate"] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw)) continue;
      if (eventDateRaw < today) continue; // skip past events

      const rawEventType = String(ev["eventType"] ?? "").trim();
      const title = String(ev["title"] ?? "").trim();
      const eventType: ScheduledCatalystType = classifyEventType(rawEventType, title) ?? "OTHER_COMPANY_CATALYST";
      const eventId = buildEventId(ticker, eventType, eventDateRaw);

      discovered.push({
        eventId,
        ticker,
        company,
        eventType,
        title: title || `${eventType} — ${company}`,
        eventDate: eventDateRaw,
        eventTime: (ev["eventTime"] as string | null) ?? null,
        beforeAfterMarket: (["BeforeMarket", "AfterMarket", "DuringMarket", "Unknown"].includes(String(ev["beforeAfterMarket"])) 
          ? ev["beforeAfterMarket"] as "BeforeMarket" | "AfterMarket" | "DuringMarket" | "Unknown"
          : "Unknown"),
        isConfirmed: ev["isConfirmed"] === true,
        expectedTopics: Array.isArray(ev["expectedTopics"]) ? ev["expectedTopics"].map(String) : [],
        potentialMarketImpact: (["High", "Medium", "Low", "Unknown"].includes(String(ev["potentialMarketImpact"]))
          ? ev["potentialMarketImpact"] as "High" | "Medium" | "Low" | "Unknown"
          : eventTypeImpact(eventType)),
        uncertainty: (["High", "Medium", "Low"].includes(String(ev["uncertainty"]))
          ? ev["uncertainty"] as "High" | "Medium" | "Low"
          : "Medium"),
        source: String(ev["source"] ?? "Web Discovery"),
        sourceType: "ReliableReporting",
        sourceOriginId: null,
        canonicalSource: null,
        classification: "Unknown",
        discoveredAt: now,
        lastUpdatedAt: now,
      });
    }

    // Merge with existing events
    let existingEvents = getCompanyEvents(ticker);
    for (const ev of discovered) {
      existingEvents = mergeCompanyEvent(existingEvents, ev);
    }
    saveCompanyEvents(ticker, existingEvents);

    const upcoming = existingEvents.filter(ev => ev.eventDate >= today);

    res.status(200).json({
      ok: true,
      ticker,
      company,
      discovered: discovered.length,
      totalUpcoming: upcoming.length,
      events: upcoming,
      _debug: {
        module: MODULE,
        aiCalled: true,
        rawCount: rawArray.length,
        validCount: discovered.length,
        tokensUsed: debug.usage?.total_tokens ?? 0,
      },
    });

  } catch (err) {
    console.error(`[company-events] discover error for ${ticker}:`, err instanceof Error ? err.message : String(err));
    res.status(500).json({ ok: false, ticker, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
