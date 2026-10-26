// A starved verify worker shows up before it reds three gates (#1713): when a gate takes more than
// SLOW_FACTOR x the worker's own median for the same scope (kind + tier), say so. The median is over
// the worker's previous runs, so a worker with fewer than MIN_HISTORY runs is never flagged.
export const SLOW_FACTOR = 2;
export const MIN_HISTORY = 3;
const HISTORY_CAP = 20;

const history = new Map<string, number[]>();
const slow = new Map<string, string>();
// #1723: durations per worker and chain kind (any tier), for placement and /api/workers.
const byKind = new Map<string, number[]>();

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Pure: the marker for one run against its history, or null. */
export function verifySlowNote(durationMs: number, priorDurationsMs: readonly number[]): string | null {
  if (priorDurationsMs.length < MIN_HISTORY) return null;
  const med = median(priorDurationsMs);
  if (med <= 0 || durationMs <= SLOW_FACTOR * med) return null;
  return `verify slow: ${Math.round(durationMs / 1000)} s vs median ${Math.round(med / 1000)} s`;
}

/** Record a finished gate; returns (and remembers, for the worker's doctor line) the slow marker when one applies. */
export function recordVerifyDuration(workerId: string, scope: string, durationMs: number): string | null {
  if (!(durationMs > 0)) return null;
  const key = `${workerId}|${scope}`;
  const prior = history.get(key) ?? [];
  const kindKey = `${workerId}|${scope.split("|")[0]}`;
  byKind.set(kindKey, [...(byKind.get(kindKey) ?? []), durationMs].slice(-HISTORY_CAP));
  const note = verifySlowNote(durationMs, prior);
  history.set(key, [...prior, durationMs].slice(-HISTORY_CAP));
  if (note) slow.set(workerId, note);
  else if (prior.length >= MIN_HISTORY) slow.delete(workerId);
  return note;
}

/** The current slow marker of a worker (doctor / console line), if its last judged gate was slow. */
export function slowVerifyNote(workerId: string): string | null {
  return slow.get(workerId) ?? null;
}

/** #1723: median measured duration (ms) of this worker's finished jobs of one kind, or null without history. */
export function expectedVerifyDurationMs(workerId: string, kind: string): number | null {
  const xs = byKind.get(`${workerId}|${kind}`);
  return xs && xs.length > 0 ? median(xs) : null;
}

/** #1723: measured median minutes per kind for one worker (for /api/workers). */
export function verifyThroughputByKind(workerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, xs] of byKind) {
    if (!k.startsWith(`${workerId}|`) || xs.length === 0) continue;
    out[k.slice(workerId.length + 1)] = Math.round((median(xs) / 60_000) * 10) / 10;
  }
  return out;
}

export function resetVerifySlowHistory(): void {
  byKind.clear();
  history.clear();
  slow.clear();
}
