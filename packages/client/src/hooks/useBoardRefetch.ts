import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { boardColumnsQueryOptions, clearBoardEtag } from "../lib/boardColumnsQuery.js";

/** Trailing-debounce window for coalescing WS-triggered board refetches. */
const REFETCH_DEBOUNCE_MS = 250;

export interface UseBoardRefetchParams {
  activeProjectId: string | null;
}

export interface UseBoardRefetchResult {
  /**
   * ETag-aware refetch of the active project's board (or `projectId` if given),
   * driven through react-query so the query cache stays the single owner. The
   * conditional GET + reconcile live in the query fn; this just triggers a fetch
   * and returns the resulting columns. `{ force: true }` drops the cached ETag
   * so the GET is unconditional (used after a project switch cleared the board).
   */
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<StatusWithIssues[] | undefined>;
  /** Debounced entrypoint: collapse a burst of `board_changed` events into one trailing fetch. */
  scheduleRefetch: () => void;
  /** Immediate coalesced fetch with in-flight dedupe (one follow-up if a fetch arrives mid-flight). */
  runCoalescedRefetch: () => void;
}

/**
 * The board's data-refetch entrypoints, now a thin layer over react-query
 * (finding §3.5). react-query owns the ETag cache (in the query fn), the
 * in-flight dedupe, and the out-of-order guard — so the old hand-rolled ETag
 * ref + monotonic sequence counter are gone. What survives is the WS-burst
 * coalescing that react-query does NOT provide: a 250ms trailing debounce plus
 * a dirty-flag follow-up, so a `board_changed` arriving mid-fetch still yields
 * one guaranteed fresh fetch afterwards.
 */
export function useBoardRefetch({ activeProjectId }: UseBoardRefetchParams): UseBoardRefetchResult {
  const queryClient = useQueryClient();
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchInFlightRef = useRef(false);
  const refetchDirtyRef = useRef(false);
  const runCoalescedRefetchRef = useRef<() => void>(() => {});

  const refetchBoard = useCallback(async (projectId?: string, options?: { force?: boolean }) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    if (options?.force) clearBoardEtag(pid);
    // fetchQuery (staleTime 0) always runs the ETag-aware query fn, dedupes onto
    // any in-flight fetch, commits only the latest result, and notifies the
    // board query's observers — replacing the removed manual dedupe/seq guard.
    return await queryClient.fetchQuery({
      ...boardColumnsQueryOptions(pid, queryClient),
      staleTime: 0,
    });
  }, [activeProjectId, queryClient]);

  // Coalesced board refetch: agent merge/exit cascades broadcast 3-6
  // board_changed events within 1-2s. runCoalescedRefetch dedupes against an
  // in-flight fetch (dirty flag -> exactly one follow-up on completion);
  // scheduleRefetch collapses an event burst into one trailing fetch per 250ms.
  const runCoalescedRefetch = useCallback(() => {
    if (refetchInFlightRef.current) {
      refetchDirtyRef.current = true;
      return;
    }
    refetchInFlightRef.current = true;
    void refetchBoard()
      .catch(() => {
        // WS-triggered refreshes were previously fire-and-forget; keep
        // failures non-fatal (the next board event retries).
      })
      .finally(() => {
        refetchInFlightRef.current = false;
        if (refetchDirtyRef.current) {
          refetchDirtyRef.current = false;
          runCoalescedRefetchRef.current();
        }
      });
  }, [refetchBoard]);
  runCoalescedRefetchRef.current = runCoalescedRefetch;

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      runCoalescedRefetchRef.current();
    }, REFETCH_DEBOUNCE_MS);
  }, []);

  // Drop any pending coalesced refetch on unmount.
  useEffect(() => () => {
    if (refetchTimerRef.current !== null) clearTimeout(refetchTimerRef.current);
  }, []);

  return { refetchBoard, scheduleRefetch, runCoalescedRefetch };
}
