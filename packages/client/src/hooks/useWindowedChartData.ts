import { useCallback, useState } from "react";
import { useApiResource } from "./useApiResource.js";

/**
 * The window selector every dashboard chart wrapped around a fetch (#732).
 *
 * `ProviderMixChart`, `ProviderCostOverTimeChart`, `ScorecardDistributionChart` and
 * `ThroughputChart` each carried a byte-identical copy of the same ladder —
 * `data`/`loading`/`error`/`days`/`retryKey`, a `cancelled` flag, and an `apiFetch` whose
 * URL differed only in its path. Token-windowed clone detection put the ProviderMix /
 * ProviderCost pair at 78 % / 72 % duplicated, and most of that was this.
 *
 * Deliberately a THIN layer over `useApiResource` (#513) rather than another ladder: the
 * cancelled-flag guard, the error normalisation and the reload counter stay in the one
 * place that owns them, and this hook adds only what is chart-specific — the `days` window
 * and the `?projectId=&days=` composition, so four charts cannot spell the query string
 * four ways.
 *
 * `W` is the chart's own window union (`14 | 30`, `7 | 30 | 90`, …), so `setDays` stays as
 * narrow as the buttons that call it and a window with no configured label spacing is a
 * type error rather than an unlabelled axis.
 */
export interface WindowedChartData<T, W extends number> {
  /** Last successful payload, or `null` while loading / after an error. */
  data: T | null;
  loading: boolean;
  /** Human-readable failure message, or `null`. */
  error: string | null;
  /** Currently selected window, in days. */
  days: W;
  setDays: (days: W) => void;
  /** Refetch the current window. */
  retry: () => void;
}

/**
 * The URL a windowed chart requests. Exported and pure so the encoding is pinned by a test
 * rather than by four call sites happening to agree — the client's convention for this
 * package is static / pure-function tests (see `useApiResource.ts`).
 */
export function windowedChartPath(path: string, projectId: string, days: number): string {
  return `${path}?projectId=${encodeURIComponent(projectId)}&days=${days}`;
}

export function useWindowedChartData<T, W extends number>(
  path: string,
  projectId: string,
  initialDays: W,
  fallbackError = "Failed to load data",
): WindowedChartData<T, W> {
  const [days, setDays] = useState<W>(initialDays);
  const { data, loading, error, reload } = useApiResource<T>(windowedChartPath(path, projectId, days), {
    fallbackError,
  });
  const retry = useCallback(() => reload(), [reload]);
  return { data, loading, error, days, setDays, retry };
}
