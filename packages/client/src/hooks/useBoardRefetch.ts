import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import {
  reconcileBoardIssueIdentity,
  deriveInactiveIssueIds,
  prunePendingWorkspaceIssueIds,
  pruneRecordKeys,
} from "../lib/boardDataReconcile.js";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { boardQueryKeys } from "./useBoardDataQueries.js";

/** Trailing-debounce window for coalescing WS-triggered board refetches. */
const REFETCH_DEBOUNCE_MS = 250;

export interface UseBoardRefetchParams {
  activeProjectId: string | null;
  /** Live mirror of the rendered columns — read for ETag/304 short-circuits and identity reuse. */
  columnsRef: MutableRefObject<StatusWithIssues[]>;
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
  setPendingWorkspaceIssueIds: Dispatch<SetStateAction<Set<string>>>;
  setLiveStats: Dispatch<SetStateAction<Record<string, LiveSessionStats>>>;
  setSessionActivityRaw: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
}

export interface UseBoardRefetchResult {
  /**
   * Conditional GET of the active project's board (or `projectId` if given).
   * Applies the reconciled columns and prunes stale live-session bookkeeping.
   * `{ force: true }` skips `If-None-Match` (used after a project switch where
   * columns were just cleared, so a 304 must not early-return an empty board).
   */
  refetchBoard: (projectId?: string, options?: { force?: boolean }) => Promise<StatusWithIssues[] | undefined>;
  /** Debounced entrypoint: collapse a burst of `board_changed` events into one trailing fetch. */
  scheduleRefetch: () => void;
  /** Immediate coalesced fetch with in-flight dedupe (one follow-up if a fetch arrives mid-flight). */
  runCoalescedRefetch: () => void;
}

/**
 * The board's data-refetch engine, extracted whole from `BoardPage`. Owns all
 * the transport bookkeeping — ETag cache, monotonic sequence guard (discard
 * out-of-order responses), trailing-debounce timer, and in-flight dedupe — so
 * the component is left with plain state and view wiring.
 *
 * The pure reconciliation of a fresh payload against live state lives in
 * `lib/boardDataReconcile` (unit-tested there); this hook is the stateful,
 * React-bound half that drives it.
 */
export function useBoardRefetch({
  activeProjectId,
  columnsRef,
  setColumns,
  setPendingWorkspaceIssueIds,
  setLiveStats,
  setSessionActivityRaw,
}: UseBoardRefetchParams): UseBoardRefetchResult {
  const queryClient = useQueryClient();
  const boardEtagRef = useRef<Record<string, string>>({});
  // Coalesced-refetch bookkeeping: monotonic sequence guard (discard responses
  // that resolve after a newer one was applied), trailing-debounce timer, and
  // in-flight dedupe with a dirty flag for one follow-up fetch.
  const refetchSeqRef = useRef(0);
  const lastAppliedSeqRef = useRef(0);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchInFlightRef = useRef(false);
  const refetchDirtyRef = useRef(false);
  const runCoalescedRefetchRef = useRef<() => void>(() => {});

  const refetchBoard = useCallback(async (projectId?: string, options?: { force?: boolean }) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    // Monotonic sequence guard: overlapping refetches can resolve out of
    // order; only the response of the newest request may be applied. The
    // 304 path is covered too — it applies nothing and leaves the newer
    // state (and its ETag) untouched.
    const seq = ++refetchSeqRef.current;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // On a forced refetch (e.g. project switch, where columns were just
    // cleared) we must NOT send If-None-Match: a 304 would early-return the
    // now-empty columnsRef and leave the board blank. Skip the conditional so
    // the server always sends the full board back.
    const cachedEtag = options?.force ? undefined : boardEtagRef.current[pid];
    if (cachedEtag) headers["If-None-Match"] = cachedEtag;
    const res = await fetch(`/api/projects/${pid}/board`, { headers });
    if (res.status === 304) {
      queryClient.setQueryData(boardQueryKeys.board(pid), columnsRef.current);
      return columnsRef.current;
    }
    if (!res.ok) {
      let message = `API error: ${res.status} ${res.statusText}`;
      try {
        const body: unknown = await res.json();
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
          message = body.error;
        }
      } catch {}
      throw new Error(message);
    }
    const board = await res.json() as StatusWithIssues[];
    if (seq <= lastAppliedSeqRef.current) {
      // A newer refetch already applied its response — discard this stale
      // one so it can't clobber fresher columns or the fresher ETag.
      return columnsRef.current;
    }
    lastAppliedSeqRef.current = seq;
    const etag = res.headers.get("ETag");
    if (etag) boardEtagRef.current[pid] = etag;
    // Reconcile the fresh payload against live state (all pure, tested in
    // lib/boardDataReconcile): reuse unchanged issue refs so IssueCard.memo can
    // skip re-render, then prune live-session bookkeeping for now-inactive issues.
    const reconciled = reconcileBoardIssueIdentity(columnsRef.current, board);
    setColumns(reconciled);
    columnsRef.current = reconciled;
    queryClient.setQueryData(boardQueryKeys.board(pid), reconciled);
    const inactiveIssueIds = deriveInactiveIssueIds(reconciled);
    setPendingWorkspaceIssueIds((prev) => prunePendingWorkspaceIssueIds(prev, reconciled));
    if (inactiveIssueIds.size > 0) {
      setLiveStats((prev) => pruneRecordKeys(prev, inactiveIssueIds));
      setSessionActivityRaw((prev) => pruneRecordKeys(prev, inactiveIssueIds));
    }
    return reconciled;
  }, [activeProjectId, columnsRef, queryClient, setColumns, setPendingWorkspaceIssueIds, setLiveStats, setSessionActivityRaw]);

  // Coalesced board refetch: agent merge/exit cascades broadcast 3-6
  // board_changed events within 1-2s, and each used to trigger its own full
  // /board fetch. runCoalescedRefetch dedupes against an in-flight fetch
  // (dirty flag -> exactly one follow-up on completion); scheduleRefetch
  // collapses an event burst into one trailing fetch per 250ms window.
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
