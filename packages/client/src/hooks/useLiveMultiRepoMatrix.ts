import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectRepoResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { fetchWorkspaceRepoStatus } from "../lib/workspaceRepoStatusQuery.js";
import { fetchProjectRepos } from "../lib/projectReposQuery.js";
import {
  buildMultiRepoMatrix,
  type MatrixWorkspaceInput,
  type MultiRepoMatrix,
} from "../lib/multiRepoMatrix.js";
import { diffMultiRepoMatrix, type MatrixSnapshot } from "../lib/diffMultiRepoMatrix.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { useBoardWsRefresh } from "./useBoardWsRefresh.js";
import { LIVE_ACTIVITY_REFRESH_REASONS } from "@agentic-kanban/shared/lib/board-events-contract";

/**
 * Board-event reasons that can change a repo × workspace cell. A merge landing, a
 * workspace appearing/closing, or a session finishing all shift the per-repo
 * merge-state fan-out; anything else (pure issue edits, dependency tweaks) can't, so
 * we don't pay for the git fan-out on those. `reconnect`/`poll` are the WS lifecycle
 * refreshes and are treated as relevant so a live panel catches up after a gap.
 */
// One shared set (#566) — this was a hand-built copy that still listed the dead
// "workspace_updated" reason. See LIVE_ACTIVITY_REFRESH_REASONS for what changed.
const RELEVANT_REASONS = LIVE_ACTIVITY_REFRESH_REASONS;

/** Debounce/coalesce window for bursts of board events (spec: ~1.5s). */
const REFRESH_DEBOUNCE_MS = 1500;
/** How long a changed cell stays flagged for its flash highlight. */
const FLASH_MS = 1200;

export interface MonitorData {
  additionalRepos: ProjectRepoResponse[];
  workspaces: MatrixWorkspaceInput[];
  matrix: MultiRepoMatrix;
}

export interface UseLiveMultiRepoMatrixResult {
  data: MonitorData | null;
  loading: boolean;
  error: string | null;
  /** cellKeys (`repoKey::workspaceId`) that changed in the latest refresh; flash these. */
  changedCells: Set<string>;
  /** ms timestamp of the last successful refresh, or null before the first. */
  lastUpdated: number | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Manual refresh (the ↻ button). Runs even while paused. */
  refresh: () => void;
}

/**
 * Live data source for the Multi-Repo Monitor (#84). Reads the batched
 * `workspace-repo-status` endpoint (#415 — one request per burst, replacing the old
 * per-workspace `repo-merge-status` + `conflicts` fan-out), re-runs it — debounced —
 * whenever a relevant board event fires, tracks which cells changed since the last
 * snapshot (for flashing), and exposes a pause toggle. Matrix *semantics* are unchanged;
 * this only owns the refresh lifecycle.
 */
export function useLiveMultiRepoMatrix(
  activeProjectId: string | null,
  leadingRepoPath: string | null,
  columns: StatusWithIssues[],
): UseLiveMultiRepoMatrixResult {
  const queryClient = useQueryClient();
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedCells, setChangedCells] = useState<Set<string>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);

  // Latest columns without re-subscribing the WS/debounce machinery on every board
  // refresh (columns churn constantly; the fetch reads them via this ref).
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Previous snapshot to diff against for the flash highlight.
  const prevSnapshotRef = useRef<MatrixSnapshot | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a stale in-flight fetch overwriting a newer one's result.
  const requestSeqRef = useRef(0);

  const load = useCallback(() => {
    if (!activeProjectId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // #415 — ONE batched request (shared react-query, deduped with the activity
        // feed and impact heatmap reacting to the same board events) replaces the
        // per-workspace repo-merge-status + conflicts fan-out. The batch already
        // excludes direct and closed workspaces server-side.
        const [additionalRepos, batch] = await Promise.all([
          fetchProjectRepos(queryClient, activeProjectId),
          fetchWorkspaceRepoStatus(queryClient, activeProjectId),
        ]);

        // A newer refresh started while we were awaiting — drop this stale result.
        if (seq !== requestSeqRef.current) return;

        const issueById = new Map(columnsRef.current.flatMap((c) => c.issues).map((i) => [i.id, i]));
        const workspaces: MatrixWorkspaceInput[] = batch.workspaces.map((w) => {
          const issue = issueById.get(w.issueId);
          return {
            id: w.workspaceId,
            issueId: w.issueId,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            branch: w.branch,
            status: w.status,
            mergedAt: w.mergedAt,
            repoStatus: w.mergeStatus,
            hasConflicts: w.conflicts?.hasConflicts ?? false,
          };
        });

        const repoInputs = [
          ...(leadingRepoPath ? [{ name: null, path: leadingRepoPath, isLeading: true }] : []),
          ...additionalRepos.map((r) => ({ name: r.name, path: r.path, isLeading: false })),
        ];
        const matrix = buildMultiRepoMatrix(repoInputs, workspaces);
        const snapshot: MatrixSnapshot = { workspaceIds: workspaces.map((w) => w.id), matrix };

        // Flash whatever changed since the previous snapshot (nothing on first load).
        const changed = diffMultiRepoMatrix(prevSnapshotRef.current, snapshot);
        prevSnapshotRef.current = snapshot;

        setData({ additionalRepos, workspaces, matrix });
        setLastUpdated(Date.now());
        setLoading(false);
        if (changed.size > 0) {
          setChangedCells(changed);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setChangedCells(new Set()), FLASH_MS);
        }
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(errorMessage(err));
        setLoading(false);
      }
    })();
  }, [activeProjectId, leadingRepoPath, queryClient]);

  // Initial load (and reload when the project/leading repo changes).
  useEffect(() => {
    prevSnapshotRef.current = null;
    setChangedCells(new Set());
    load();
  }, [load]);

  // Coalesced live refresh (#514). The 1.5s window is this panel's own — the matrix is
  // expensive to rebuild — so it is passed explicitly rather than taking the 250ms
  // default. `paused` is part of the predicate: a paused matrix must not even schedule,
  // and the old copy's private timer would otherwise fire after unpausing.
  useBoardWsRefresh({
    projectId: activeProjectId,
    shouldRefetch: (reason) => !pausedRef.current && RELEVANT_REASONS.has(reason),
    refresh: load,
    debounceMs: REFRESH_DEBOUNCE_MS,
  });

  useEffect(
    () => () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Resume catches up immediately (any events during the pause were dropped).
  const setPausedAndCatchUp = useCallback(
    (next: boolean) => {
      setPaused(next);
      if (!next) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        load();
      }
    },
    [load],
  );

  const refresh = useCallback(() => {
    // Manual refresh cancels any pending debounce and loads now, even while paused.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    load();
  }, [load]);

  return { data, loading, error, changedCells, lastUpdated, paused, setPaused: setPausedAndCatchUp, refresh };
}
