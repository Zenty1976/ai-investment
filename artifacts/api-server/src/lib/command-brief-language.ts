/**
 * Command Brief — Explanation Language Instruction Builder
 *
 * Pure function — no side effects, no imports with pino or express.
 * Exported here so it can be tested without pulling in route dependencies.
 */

export type ExplanationLanguage = "en" | "da";

/**
 * Builds the per-request language instruction embedded in the Command Brief
 * user prompt. Only the `whatThisMeans` field is affected — all other fields
 * remain in English regardless of the selected language.
 *
 * @param lang  "en" (default) or "da"
 */
export function buildExplanationLanguageInstruction(lang: ExplanationLanguage): string {
  if (lang === "da") {
    return [
      'Generate the "whatThisMeans" field in natural, easy-to-understand Danish (3–6 short sentences).',
      "Explain investment terminology in ordinary Danish rather than translating terms literally.",
      'For example, explain "WaitForEvent" as "systemet venter på begivenheden før en ny vurdering",',
      '"Catalyst Intelligence" as "systemets analyse af kommende selskabsbegivenheder",',
      'and "price asymmetry" as "forholdet mellem potentiel gevinst og tab".',
      "Do NOT make independent buy/sell recommendations.",
      "Trade Decision state takes precedence over Catalyst sentiment.",
    ].join(" ");
  }
  return [
    'Generate the "whatThisMeans" field in English (3–6 short sentences).',
    "Explain what the brief means for the user in plain language — not a word-for-word repetition of the items.",
    "Do NOT make independent buy/sell recommendations.",
    "Trade Decision state takes precedence over Catalyst sentiment.",
  ].join(" ");
}
