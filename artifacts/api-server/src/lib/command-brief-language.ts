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
  const shared = `
WHAT THIS MEANS — GENERATION RULES

Purpose: "whatThisMeans" is a short explanatory walkthrough of the important Command Brief items shown above it. It is NOT another generic summary or a restatement of the headline.

Structure: Write one short explanatory paragraph per important Command Brief item. Use the company name or a clear subject at the start of each paragraph — for example "Keysight:", "NVIDIA:", "Serve Robotics:", "Employment report:". Separate paragraphs with newline characters inside the string. Do NOT use JSON arrays; whatThisMeans is ONE string.

For each important item, explain:
1. What the item actually means in ordinary language (not jargon).
2. Why the system considers it important right now.
3. What the current state means for the user.
4. If relevant, what the system is waiting for before it reassesses.

Preserve this hierarchy when explaining:
- Catalyst Intelligence = WHY a company or event may be interesting.
- Opportunity Finder = HOW attractive an opportunity currently appears.
- Trade Decision = WHAT the system currently intends to do about it.
- Trade Review = WHETHER there is an actionable trade right now.

WaitForEvent rule: When an item's Trade Decision is WaitForEvent, the explanation must make clear in ordinary language that (a) the company may look interesting or positive, (b) the system is intentionally waiting for a specific event, (c) what that event is, and (d) the company will be reassessed after the event. Never turn positive Catalyst sentiment into an implied buy recommendation.

PrepareToBuy rule: If Trade Decision says PrepareToBuy, explain that this is stronger than merely monitoring an opportunity, but that it still does NOT mean a trade is ready now unless Trade Review explicitly says so.

Trade Review rule: If readyTradeCount is 0, make it understandable that nothing currently requires the user's approval. Avoid repeating this mechanically if the Action Status directly below already makes it obvious.

Do NOT make independent buy/sell recommendations. Trade Decision state takes precedence over Catalyst sentiment when wording the explanation.

Length: Approximately 1–2 short sentences per important item. Keep the overall explanation concise enough to scan quickly. Do not force it into an arbitrary sentence count.`;

  if (lang === "da") {
    return `${shared}

Language: Write the entire "whatThisMeans" field in natural, simple Danish. Do NOT translate the field names, headline, items, or actionStatus — only "whatThisMeans" is in Danish.

Explain concepts by meaning rather than translating literally. Use these phrasings when relevant:
- WaitForEvent → "systemet venter på begivenheden, før aktien vurderes igen"
- PrepareToBuy → "systemet forbereder et muligt køb, men der er endnu ikke en handel klar"
- Catalyst Intelligence → "systemets analyse af kommende begivenheder omkring selskabet"
- Opportunity Finder → "systemets vurdering af, hvor attraktiv en mulighed er"
- Trade Decision → "systemets aktuelle beslutning om, hvad det vil gøre"
- Trade Review → "den endelige godkendelse, før en handel kan udføres"
- Opportunity cost of cash → "risikoen for at gå glip af kursstigninger, mens pengene står kontant"
- No trades ready → "Der er ikke nogen handel, du skal godkende eller tage stilling til lige nu."

Do NOT write the explanation in English. Do NOT translate any other Command Brief field.`;
  }

  return `${shared}

Language: Write the entire "whatThisMeans" field in natural, plain English. Do NOT translate any other Command Brief field — only "whatThisMeans" is subject to this instruction.

Use everyday language. Avoid jargon like "WaitForEvent", "Catalyst Intelligence", "price asymmetry" without explaining what they mean. For example:
- WaitForEvent → "the system is waiting for the event before reassessing"
- PrepareToBuy → "the system is preparing a potential buy, but no trade is ready yet"
- Catalyst Intelligence → "the system's analysis of upcoming company events"`;
}
