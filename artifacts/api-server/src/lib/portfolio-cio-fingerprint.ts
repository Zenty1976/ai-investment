/**
 * CIO Input Fingerprint
 *
 * Lightweight module with zero external dependencies — safe to import in tests
 * without pulling in pino, OpenAI, or any other heavy dependency.
 *
 * Produces a deterministic hash of all material CIO inputs so the synthesiser
 * can skip the AI call when nothing meaningful has changed.
 */

/**
 * Deterministic djb2-family hash of a JSON-serialised object.
 * Used to detect whether material CIO inputs have changed since the last run.
 */
export function computeCioFingerprint(data: unknown): string {
  const str = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
