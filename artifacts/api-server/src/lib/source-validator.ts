/**
 * Source Validator
 *
 * Strips sources that come from unapproved domains or are older than the
 * allowed recency window. Used as a server-side safety net after Zod
 * validation — the model is already instructed to use only approved sources,
 * but this ensures the constraint is enforced regardless of model output.
 */

/** Approved root domains (subdomains such as finance.yahoo.com are accepted). */
const APPROVED_DOMAINS: ReadonlySet<string> = new Set([
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "cnbc.com",
  "marketwatch.com",
  "yahoo.com",       // covers finance.yahoo.com
  "investing.com",
  "apnews.com",
  "economist.com",
  "barrons.com",
  "morningstar.com",
  // Official exchanges
  "nyse.com",
  "nasdaq.com",
  "londonstockexchange.com",
  "euronext.com",
  // Central banks
  "federalreserve.gov",
  "ecb.europa.eu",
  "boj.or.jp",
  "bankofengland.co.uk",
  "bis.org",
]);

/** Maximum age in days for a source with a known publication date. */
const MAX_SOURCE_AGE_DAYS = 7;

export function isApprovedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return [...APPROVED_DOMAINS].some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );
  } catch {
    return false;
  }
}

export function isRecentPublication(published: string | undefined, nowIso: string): boolean {
  if (!published) return true; // unknown date — cannot reject
  try {
    const ageMs = new Date(nowIso).getTime() - new Date(published).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays <= MAX_SOURCE_AGE_DAYS;
  } catch {
    return true; // unparseable date — cannot reject
  }
}

export interface ValidatedSource {
  title: string;
  url: string;
  published?: string;
}

/**
 * Filter a sources array to approved domains and recent publications.
 * Returns the filtered list and the count of rejected entries for logging.
 */
export function filterSources(
  sources: ValidatedSource[],
  nowIso: string
): { accepted: ValidatedSource[]; rejectedCount: number } {
  const accepted = sources.filter(
    (s) => isApprovedDomain(s.url) && isRecentPublication(s.published, nowIso)
  );
  return { accepted, rejectedCount: sources.length - accepted.length };
}
