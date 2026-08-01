/**
 * Company Identity Store
 *
 * Resolves a Saxo portfolio symbol to the corresponding Company Monitor
 * repository key using a 5-step priority chain:
 *
 *   1. Stable Saxo UIC + assetType  (most reliable — instrument-level unique)
 *   2. ISIN                         (globally unique)
 *   3. Explicit saved alias         (previously learned or manually registered)
 *   4. Exact normalised ticker      (key suffix or stored company.ticker)
 *   5. Normalised company name      (strips suffixes like A/S, Inc, B-share; substring match)
 *
 * Every successful match is persisted so subsequent calls skip the scan.
 * Consumers should call resolve() per position and use registerAlias() to
 * add known mappings up front when stable identifiers are available.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dir, "../../data");
const IDENTITY_FILE = join(DATA_DIR, "company-identity.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchMethod = "uic" | "isin" | "alias" | "ticker" | "name";

interface AliasEntry {
  companyMonitorKey: string;
  matchedBy: MatchMethod;
  learnedAt: string;
}

interface IdentityData {
  /** normalised portfolio symbol (UPPER) → alias entry */
  aliases: Record<string, AliasEntry>;
}

export interface CompanyMonitorCandidate {
  /** full repository key, e.g. "company-monitor:NOVO" */
  key: string;
  result: Record<string, unknown>;
}

export interface ResolveResult {
  key: string;
  method: MatchMethod;
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Strip trailing share-class letters, legal-form suffixes and punctuation
 * so that "Novo Nordisk B" and "Novo Nordisk A/S" both reduce to "novo nordisk".
 *
 * The regex is applied repeatedly until it makes no further change so that
 * multiple trailing tokens are removed (e.g. "Acme Corp. B" → "acme").
 */
const TRAILING_SUFFIX_RE =
  /\s*\b(A\/S|Inc\.?|Corp\.?|Ltd\.?|LLC|PLC|SE|NV|GmbH|AG|SA|Co\.?|S\.?A\.?|ASA|AB|Oy|Plc|BV|Sdn Bhd|Class\s+[A-Z]{1,2}|[A-Z]{1,2}(?=\s*$))\s*$/i;

function normaliseName(raw: string): string {
  let s = raw.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(TRAILING_SUFFIX_RE, "").trim();
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}

function normaliseSymbol(s: string): string {
  return s.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class CompanyIdentityStore {
  private data: IdentityData = { aliases: {} };

  constructor() {
    this.load();
  }

  private load(): void {
    if (!existsSync(IDENTITY_FILE)) return;
    try {
      this.data = JSON.parse(readFileSync(IDENTITY_FILE, "utf-8")) as IdentityData;
    } catch {
      this.data = { aliases: {} };
    }
  }

  private persist(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(IDENTITY_FILE, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {
      // non-fatal — in-memory state still works for this request
    }
  }

  /**
   * Explicitly register an alias (e.g. from a UI, admin tool, or stable import).
   * This is stored at priority 3 (after UIC and ISIN checks).
   */
  registerAlias(
    portfolioSymbol: string,
    companyMonitorKey: string,
    matchedBy: MatchMethod = "alias"
  ): void {
    const sym = normaliseSymbol(portfolioSymbol);
    this.data.aliases[sym] = {
      companyMonitorKey,
      matchedBy,
      learnedAt: new Date().toISOString(),
    };
    this.persist();
  }

  /**
   * Resolve a portfolio symbol to a Company Monitor repository key.
   *
   * @param portfolioSymbol  Saxo display symbol, e.g. "NOVO B"
   * @param opts             Position metadata for higher-priority matching
   * @param candidates       All current company-monitor repository entries
   * @returns                ResolveResult on success, null when no match found
   */
  resolve(
    portfolioSymbol: string,
    opts: {
      uic?: number | string | null;
      assetType?: string | null;
      isin?: string | null;
      companyName?: string | null;
    },
    candidates: CompanyMonitorCandidate[]
  ): ResolveResult | null {
    const symUpper = normaliseSymbol(portfolioSymbol);

    // ── 1. UIC + assetType ────────────────────────────────────────────────────
    if (opts.uic != null && opts.assetType) {
      const uicStr = String(opts.uic);
      const atLower = opts.assetType.toLowerCase();
      for (const c of candidates) {
        const company = c.result.company as Record<string, unknown> | undefined;
        if (
          company &&
          String(company.uic ?? "") === uicStr &&
          String(company.assetType ?? "").toLowerCase() === atLower
        ) {
          this.registerAlias(portfolioSymbol, c.key, "uic");
          return { key: c.key, method: "uic" };
        }
      }
    }

    // ── 2. ISIN ───────────────────────────────────────────────────────────────
    if (opts.isin) {
      const isinUpper = opts.isin.trim().toUpperCase();
      for (const c of candidates) {
        const company = c.result.company as Record<string, unknown> | undefined;
        if (company && String(company.isin ?? "").toUpperCase() === isinUpper) {
          this.registerAlias(portfolioSymbol, c.key, "isin");
          return { key: c.key, method: "isin" };
        }
      }
    }

    // ── 3. Explicit saved alias ───────────────────────────────────────────────
    const saved = this.data.aliases[symUpper];
    if (saved) {
      const stillExists = candidates.some((c) => c.key === saved.companyMonitorKey);
      if (stillExists) {
        return { key: saved.companyMonitorKey, method: saved.matchedBy };
      }
      // Target no longer exists — remove stale alias and fall through
      delete this.data.aliases[symUpper];
      this.persist();
    }

    // ── 4. Exact normalised ticker ────────────────────────────────────────────
    for (const c of candidates) {
      // 4a. key suffix match: "company-monitor:MSFT" → "MSFT"
      const suffix = c.key.startsWith("company-monitor:")
        ? normaliseSymbol(c.key.slice("company-monitor:".length))
        : normaliseSymbol(c.key);
      if (suffix === symUpper) {
        this.registerAlias(portfolioSymbol, c.key, "ticker");
        return { key: c.key, method: "ticker" };
      }
      // 4b. stored company.ticker match
      const company = c.result.company as Record<string, unknown> | undefined;
      if (company && normaliseSymbol(String(company.ticker ?? "")) === symUpper) {
        this.registerAlias(portfolioSymbol, c.key, "ticker");
        return { key: c.key, method: "ticker" };
      }
    }

    // ── 5. Normalised company name fallback ───────────────────────────────────
    if (opts.companyName) {
      const posNorm = normaliseName(opts.companyName);
      if (posNorm.length >= 3) {
        for (const c of candidates) {
          const company = c.result.company as Record<string, unknown> | undefined;
          const storedNorm = normaliseName(String(company?.name ?? ""));
          if (
            storedNorm.length >= 3 &&
            (posNorm.includes(storedNorm) || storedNorm.includes(posNorm))
          ) {
            this.registerAlias(portfolioSymbol, c.key, "name");
            return { key: c.key, method: "name" };
          }
        }
      }
    }

    return null;
  }
}

export const companyIdentityStore = new CompanyIdentityStore();
