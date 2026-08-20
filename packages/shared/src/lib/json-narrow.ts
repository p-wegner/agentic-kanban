// Narrowing helpers for untyped JSON (#534).
//
// These lived in `agent-stream/shared.ts`, which is where the agent-stream parser
// happens to need them — so anything else that wanted them either imported from a
// parser-shaped module or, far more often, re-declared its own. The result was two
// exported near-copies (one in a 213-line client file imported by nothing but its
// own test) and twelve private `isRecord`/`asRecord`/`optionalString` declarations,
// several already drifted: one `stringifyValue` lacked the `?? ""` guard, one
// `contentToText` trimmed where this one does not.
//
// Pure — no node imports — so it is safe from the client and from the shared barrel.
// `agent-stream/shared.ts` re-exports these so its existing importers are unaffected.

/** The value as a plain object, or `{}` — never null, never an array. */
export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The value as a plain object, or `null` when it is not one.
 *
 * Distinct from `objectValue` on purpose: that one erases "absent" into `{}`, which
 * is convenient for chained reads but useless when the CALLER must distinguish "not
 * an object" from "an empty object" — which is exactly why several sites grew their
 * own `asRecord`.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Whether the value is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}

/** A non-empty object, or undefined. */
export function optionalObject(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

/** A non-empty string, or undefined. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** A string, or null — the nullable sibling of `stringValue`. */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number, or 0. */
export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A finite number, or null — for callers that must not confuse "absent" with 0. */
export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Render a value as a string. `undefined` becomes "" rather than "undefined". */
export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

/** Flatten an Anthropic-style content value (string, or array of blocks) to text. */
export function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = objectValue(block);
      return stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.message) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

/** First non-blank string value among `keys`, or "". */
export function getString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** The value as an array of strings, dropping non-strings. */
export function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
