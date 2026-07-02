// Observability for wire-format drift WITHIN a known event type (arch-review #994).
//
// unknown-events.ts only fires when an event's `type` is unrecognized. A field
// RENAME inside an already-known type (the #976 codex usage-shape mismatch was
// exactly this, for one field cluster) never reaches that detector: the parser
// still matches the type, then a `numberValue`/`stringValue` coercion silently
// defaults the renamed field to 0/undefined. This module gives per-provider
// event schemas (see claude-schema.ts / codex-schema.ts / copilot-schema.ts /
// pi-schema.ts) a place to report exactly that failure: "this event's type
// matched, but zod rejected/stripped fields the schema expects" — counted and
// (rate-limited) logged the same way unknown-events.ts does for unknown types.

export interface UnknownFieldCounter {
  /** provider:type -> count of schema-validation field mismatches seen. */
  readonly counts: ReadonlyMap<string, number>;
  /** Total field-drift occurrences across all providers/types. */
  readonly total: number;
}

const counts = new Map<string, number>();
let total = 0;

const LOG_WINDOW_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

export type UnknownFieldLogger = (message: string, detail: Record<string, unknown>) => void;

const defaultLogger: UnknownFieldLogger = (message, detail) => {
  // eslint-disable-next-line no-console -- operational diagnostic, matches unknown-events.ts style
  console.warn(message, detail);
};

let logger: UnknownFieldLogger = defaultLogger;
let nowFn: () => number = () => Date.now();

/** Override the sink (tests / a future metrics backend). Returns the previous logger. */
export function setUnknownFieldLogger(next: UnknownFieldLogger): UnknownFieldLogger {
  const prev = logger;
  logger = next;
  return prev;
}

/** Override the clock (tests). Returns the previous clock. */
export function setUnknownFieldClock(next: () => number): () => number {
  const prev = nowFn;
  nowFn = next;
  return prev;
}

/** Reset all counters and rate-limit state (tests). */
export function resetUnknownFieldCounters(): void {
  counts.clear();
  lastLoggedAt.clear();
  total = 0;
}

/** Snapshot the current unknown-field counters (for a metrics endpoint / inspection). */
export function getUnknownFieldCounters(): UnknownFieldCounter {
  return { counts: new Map(counts), total };
}

/**
 * Record one schema-validation field mismatch for a RECOGNIZED event type: the
 * `type` matched a known provider event, but the zod schema for that type found
 * unexpected/missing fields (a rename, a shape change) that the duck-typed
 * coercions would otherwise have silently defaulted to 0/undefined. `detail` is
 * a short human-readable description (e.g. the zod issue paths) for the log.
 */
export function recordUnknownFieldDrift(provider: string, eventType: string, detail: string): void {
  const key = `${provider}:${eventType}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  total += 1;

  const now = nowFn();
  const last = lastLoggedAt.get(key);
  if (last === undefined || now - last >= LOG_WINDOW_MS) {
    lastLoggedAt.set(key, now);
    logger(
      `[agent-stream] field drift in known event type from provider '${provider}': '${eventType}' ` +
        `(${detail} — possible CLI wire-format field rename)`,
      { provider, eventType, detail, count: counts.get(key) ?? 1 },
    );
  }
}
