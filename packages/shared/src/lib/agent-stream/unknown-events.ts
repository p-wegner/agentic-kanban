// Observability for external wire-format drift (arch-review #898).
//
// Agent CLI output is parsed against literal event names reverse-engineered from
// the provider 0.x CLIs — there is no in-repo schema. When a provider renames or
// adds an event type, the parser silently returns `undefined` and the event is
// swallowed: no display, no stats, no trace. That is the exact failure behind the
// recurring "0 tokens" misdiagnosis (a codex `turn.completed` rename drops the
// usage event => the workspace shows zero tokens with no error).
//
// This module makes that drift OBSERVABLE without changing the swallow behavior:
// a VALID JSON event whose `type` no parser recognized is counted and (rate-
// limited) logged, so a CLI rename surfaces as a loud "unknown event type"
// signal instead of a silent zero.

export interface UnknownEventCounter {
  /** provider:type -> count of unrecognized-but-valid-JSON events seen. */
  readonly counts: ReadonlyMap<string, number>;
  /** Total unrecognized events across all providers/types. */
  readonly total: number;
}

const counts = new Map<string, number>();
let total = 0;

// Escalation threshold (#956): per-key rate-limited logs are easy to miss when a
// provider drifts wholesale (every event unknown). Once a PROVIDER accumulates
// this many unknown events, emit ONE louder alert naming the provider and the
// most frequent unknown types, so sustained drift is a single unmissable line
// instead of a slow drip. Counts are per provider (this module has no session
// context — the parse hot path is provider-scoped), which is the right grain:
// drift comes from the CLI binary, not from one session.
export const UNKNOWN_EVENT_ALERT_THRESHOLD = 10;
const providerTotals = new Map<string, number>();
const alertedProviders = new Set<string>();

// Rate-limit the log so a sustained stream of an unknown type does not flood the
// console. We log the first occurrence of each distinct provider:type key, then
// at most once per key per window thereafter.
const LOG_WINDOW_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

export type UnknownEventLogger = (message: string, detail: Record<string, unknown>) => void;

const defaultLogger: UnknownEventLogger = (message, detail) => {
  // eslint-disable-next-line no-console -- operational diagnostic, matches session-lifecycle.ts style
  console.warn(message, detail);
};

let logger: UnknownEventLogger = defaultLogger;
// `now` is injectable so tests can drive the rate-limit window deterministically
// (the shared package forbids ambient Date.now() in some contexts; default here
// is fine since this is a node-side diagnostic, not a parse-determinism path).
let nowFn: () => number = () => Date.now();

/** Override the sink (tests / a future metrics backend). Returns the previous logger. */
export function setUnknownEventLogger(next: UnknownEventLogger): UnknownEventLogger {
  const prev = logger;
  logger = next;
  return prev;
}

/** Override the clock (tests). Returns the previous clock. */
export function setUnknownEventClock(next: () => number): () => number {
  const prev = nowFn;
  nowFn = next;
  return prev;
}

/** Reset all counters and rate-limit state (tests). */
export function resetUnknownEventCounters(): void {
  counts.clear();
  lastLoggedAt.clear();
  providerTotals.clear();
  alertedProviders.clear();
  total = 0;
}

/** Snapshot the current unknown-event counters (for a metrics endpoint / inspection). */
export function getUnknownEventCounters(): UnknownEventCounter {
  return { counts: new Map(counts), total };
}

/**
 * Record one unrecognized-but-valid-JSON agent stream event. The `eventType` is
 * the raw `type` field from the wire object (or "<no-type>" when absent). Counts
 * are keyed by `provider:eventType`; the log is rate-limited per key.
 */
export function recordUnknownAgentEvent(provider: string, eventType: string | undefined): void {
  const type = eventType && eventType.trim() ? eventType : "<no-type>";
  const key = `${provider}:${type}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  total += 1;

  const now = nowFn();
  const last = lastLoggedAt.get(key);
  if (last === undefined || now - last >= LOG_WINDOW_MS) {
    lastLoggedAt.set(key, now);
    logger(
      `[agent-stream] unknown event type from provider '${provider}': '${type}' ` +
        "(valid JSON, no parser matched — possible CLI wire-format drift)",
      { provider, eventType: type, count: counts.get(key) ?? 1 },
    );
  }

  // Threshold alert (#956): fires ONCE per provider when its cumulative unknown
  // count crosses the threshold (reset via resetUnknownEventCounters).
  const providerTotal = (providerTotals.get(provider) ?? 0) + 1;
  providerTotals.set(provider, providerTotal);
  if (providerTotal >= UNKNOWN_EVENT_ALERT_THRESHOLD && !alertedProviders.has(provider)) {
    alertedProviders.add(provider);
    const sampleTypes = [...counts.entries()]
      .filter(([k]) => k.startsWith(`${provider}:`))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, c]) => `${k.slice(provider.length + 1)} (${c}x)`);
    logger(
      `[agent-stream] ALERT: provider '${provider}' has produced ${providerTotal} unknown stream events — ` +
        "its CLI wire format has likely drifted (auto-update?). Check the installed CLI version against " +
        `maxKnown in agent-cli-version.service.ts. Top unknown types: ${sampleTypes.join(", ")}`,
      { provider, total: providerTotal, sampleTypes },
    );
  }
}
