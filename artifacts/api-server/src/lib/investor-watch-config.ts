/**
 * Investor Watch — Central configuration
 *
 * The six initial investors tracked by the module.
 * Add entries here to track additional investors — no backend or frontend
 * redesign required.
 */

export interface InvestorConfig {
  id: string;
  name: string;
  organization: string;
  focusLabel: string;
  enabled: boolean;
  displayOrder: number;
  /**
   * Short list of search / analysis priorities that the AI prompt uses
   * to focus on each investor's relevant primary sources.
   */
  analysisPriorities: string[];
}

export const INVESTOR_WATCH_CONFIG: InvestorConfig[] = [
  {
    id: "michael-burry",
    name: "Michael Burry",
    organization: "Scion Asset Management",
    focusLabel: "Bobler / overreaktioner / contrarian",
    enabled: true,
    displayOrder: 1,
    analysisPriorities: [
      "Scion Asset Management 13F filings",
      "direct public statements and verified social-media posts",
      "notable contrarian positions and valuation/bubble warnings",
      "major portfolio changes: exits, new positions",
      "Be especially cautious with sensational headlines claiming Burry 'predicted a crash' — verify the underlying primary evidence",
    ],
  },
  {
    id: "stanley-druckenmiller",
    name: "Stanley Druckenmiller",
    organization: "Duquesne Family Office",
    focusLabel: "Makro / likviditet / sektorrotation",
    enabled: true,
    displayOrder: 2,
    analysisPriorities: [
      "macro outlook: rates, liquidity, monetary policy",
      "sector rotation and major disclosed equity themes",
      "interviews and conference appearances",
      "Duquesne Family Office filings",
    ],
  },
  {
    id: "howard-marks",
    name: "Howard Marks",
    organization: "Oaktree Capital Management",
    focusLabel: "Risiko / markedspsykologi / kredit",
    enabled: true,
    displayOrder: 3,
    analysisPriorities: [
      "official Oaktree Capital memos — highest evidence priority",
      "credit conditions and risk appetite",
      "valuations and market psychology",
      "cycle positioning",
    ],
  },
  {
    id: "warren-buffett",
    name: "Warren Buffett",
    organization: "Berkshire Hathaway",
    focusLabel: "Kvalitet / valuation / kapitalallokering / cash",
    enabled: true,
    displayOrder: 4,
    analysisPriorities: [
      "Berkshire Hathaway 13F and SEC filings",
      "annual and quarterly reports and shareholder letters",
      "major purchases, sales, cash levels, and buybacks",
      "major public comments from Buffett or Munger successors",
      "Do NOT invent a 'Buffett view' from unrelated market commentary",
    ],
  },
  {
    id: "bill-ackman",
    name: "Bill Ackman",
    organization: "Pershing Square Capital Management",
    focusLabel: "Koncentrerede aktiecases / aktivistinvestering",
    enabled: true,
    displayOrder: 5,
    analysisPriorities: [
      "Pershing Square investor communications and filings",
      "direct public statements and social media",
      "major concentrated holdings and activist theses",
      "macro statements and material position changes",
    ],
  },
  {
    id: "david-tepper",
    name: "David Tepper",
    organization: "Appaloosa Management",
    focusLabel: "Makro / opportunistiske investeringer / contrarian",
    enabled: true,
    displayOrder: 6,
    analysisPriorities: [
      "major interviews and public appearances",
      "Appaloosa Management 13F filings",
      "macro positioning and opportunistic/contrarian themes",
      "major equity exposure changes",
    ],
  },
];

export function getEnabledInvestors(): InvestorConfig[] {
  return INVESTOR_WATCH_CONFIG
    .filter(i => i.enabled)
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

export function getInvestorById(id: string): InvestorConfig | undefined {
  return INVESTOR_WATCH_CONFIG.find(i => i.id === id);
}
