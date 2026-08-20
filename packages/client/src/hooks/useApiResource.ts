import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

/**
 * One fetch-in-effect ladder for the analytics/panel components (#513).
 *
 * ~40 files repeat the same five pieces: `data`/`loading`/`error` state, a `cancelled`
 * flag in the effect, the `err instanceof Error ? err.message : "Failed to load …"`
 * ternary (37 copies), and a `retryKey` counter to force a re-run (13 copies).
 *
 * THE CANCELLED FLAG IS THE REASON THIS IS WORTH A HOOK, not the line count. It is the
 * piece most easily forgotten, and it was: `StaleWorkDashboard` had none, so switching
 * project mid-flight could land the OLD project's board in state, and unmounting
 * mid-flight set state on a dead component. Once the guard lives here it cannot be
 * omitted by the next panel.
 *
 * `path: null` means "nothing to load yet" (a panel whose `projectId` is still null).
 * That is distinct from a path that fails: it settles as not-loading with no error,
 * rather than firing a request for `/api/…/null`.
 *
 * Not react-query, deliberately. `AppQueryProvider` is mounted and would also work, but
 * these panels want plain "fetch on mount / on deps change" with no cache key, sharing,
 * or invalidation story — adopting a cache here would mean inventing keys for 40 call
 * sites and reasoning about staleness the panels do not currently have. The board query,
 * which DOES need caching and ETags, stays on react-query.
 */
export interface ApiResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-run the request; replaces the hand-rolled `retryKey` counters. */
  reload: () => void;
}

export interface UseApiResourceOptions {
  /** Message used when the thrown value is not an Error. Mirrors the old ternaries. */
  fallbackError?: string;
  /** Skip fetching while false — for panels gated on something other than the path. */
  enabled?: boolean;
}

/**
 * Should this render issue a request?
 *
 * Exported and pure so it can be tested directly — this package's convention is static /
 * pure-function tests, with no `@testing-library/react` (see the note in
 * `OnboardingWizard.test.tsx`). The effect body's cancelled guard is genuinely not
 * unit-testable under that convention; it is covered only by the migrated panels'
 * behaviour, which is worth knowing rather than glossing.
 *
 * Declared as a type predicate (`path is string`) so the effect below gets `path`
 * narrowed for free. The alternative was a non-null assertion at the `apiFetch` call —
 * i.e. telling the checker something instead of showing it.
 */
export function shouldFetch(path: string | null, enabled: boolean): path is string {
  return path !== null && enabled;
}

/**
 * The error text, normalised — the `err instanceof Error ? err.message : "Failed to
 * load …"` ternary that existed in 37 copies. Pure, so the contract is pinned.
 */
export function normalizeFetchError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function useApiResource<T>(
  path: string | null,
  opts: UseApiResourceOptions = {},
): ApiResource<T> {
  const { fallbackError = "Failed to load data", enabled = true } = opts;
  const [data, setData] = useState<T | null>(null);
  // Start loading only when there is something to load, so a panel with no projectId
  // renders its empty state instead of a spinner that never resolves.
  const [loading, setLoading] = useState<boolean>(shouldFetch(path, enabled));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Kept in a ref so changing the message does not re-trigger the request.
  const fallbackRef = useRef(fallbackError);
  fallbackRef.current = fallbackError;

  useEffect(() => {
    if (!shouldFetch(path, enabled)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<T>(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(normalizeFetchError(err, fallbackRef.current));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, enabled, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { data, loading, error, reload };
}
