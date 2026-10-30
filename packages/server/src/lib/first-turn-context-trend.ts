/**
 * Context-size ratchet (#1765): a project's median first-turn context over the last N
 * builders against the N before them. Pure — callers supply the per-session
 * `stats.firstTurnContextTokens` values, oldest first.
 */
export interface FirstTurnContextRise {
  previousMedian: number;
  currentMedian: number;
  deltaPct: number;
  message: string;
}

export const FIRST_TURN_RISE_THRESHOLD = 0.2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Null unless there are two full windows and the newer median rose by more than the threshold. */
export function detectFirstTurnContextRise(
  valuesOldestFirst: number[],
  windowSize = 10,
  threshold = FIRST_TURN_RISE_THRESHOLD,
): FirstTurnContextRise | null {
  const v = valuesOldestFirst.filter((n) => Number.isFinite(n) && n > 0);
  if (windowSize < 1 || v.length < windowSize * 2) return null;
  const current = v.slice(-windowSize);
  const previous = v.slice(-windowSize * 2, -windowSize);
  const currentMedian = median(current);
  const previousMedian = median(previous);
  const delta = (currentMedian - previousMedian) / previousMedian;
  if (delta <= threshold) return null;
  const deltaPct = Math.round(delta * 100);
  return {
    previousMedian,
    currentMedian,
    deltaPct,
    message: `Median first-turn context rose ${deltaPct}% (${Math.round(previousMedian)} -> ${Math.round(currentMedian)} tokens) over the last ${windowSize} builders.`,
  };
}
