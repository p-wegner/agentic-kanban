// A starved verify worker shows up before it reds three gates (#1713): when a gate takes more than
// SLOW_FACTOR x the worker's own median for the same scope (kind + tier), say so. The median is over
// the worker's previous runs, so a worker with fewer than MIN_HISTORY runs is never flagged.
export const SLOW_FACTOR = 2;
export const MIN_HISTORY = 3;
const HISTORY_CAP = 20;

const history = new Map<string, number[]>();
const slow = new Map<string, string>();

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

export function resetVerifySlowHistory(): void {
  history.clear();
  slow.clear();
}
