import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectRepoResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import {
  buildMultiRepoMatrix,
  type MatrixWorkspaceInput,
  type MultiRepoMatrix,
  type RepoMergeStatusResponse,
} from "../lib/multiRepoMatrix.js";
import { diffMultiRepoMatrix, type MatrixSnapshot } from "../lib/diffMultiRepoMatrix.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
  mergedAt: string | null;
  isDirect: boolean;
}

/**
 * Every non-terminal workspace status (terminal = closed/merged). The matrix shows
 * "active (non-closed) workspaces" per the spec — an allowlist of only the running
 * states would silently drop `ready_for_merge`/`blocked`/`error` workspaces, and a
 * ready-for-merge workspace with stranded siblings is exactly the case (#69) this
 * monitor exists to surface. Kept in sync with WorkspaceStatus (workspace-status.ts).
 */
const NON_CLOSED_WORKSPACE_STATUSES = [
  "active",
  "idle",
  "blocked",
  "reviewing",
  "fixing",
  "ready_for_merge",
  "awaiting-plan-approval",
  "error",
].join(",");

/**
 * Board-event reasons that can change a repo × workspace cell. A merge landing, a
 * workspace appearing/closing, or a session finishing all shift the per-repo
 * merge-state fan-out; anything else (pure issue edits, dependency tweaks) can't, so
 * we don't pay for the git fan-out on those. `reconnect`/`poll` are the WS lifecycle
 * refreshes and are treated as relevant so a live panel catches up after a gap.
 */
const RELEVANT_REASONS = new Set<string>([
  "board_changed",
  "workspace_created",
  "workspace_setup",
  "workspace_merged",
  "workspace_closed",
  "workspace_idle",
  "workspace_updated",
  "workspace_ready_for_merge",
  "session_completed",
  "session_launched",
  "session_stopped",
  "reconnect",
  "poll",
]);

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
 * Live data source for the Multi-Repo Monitor (#84). Fans out the per-workspace
 * `repo-merge-status` + `conflicts` checks (as #82 did), but re-runs them — debounced —
 * whenever a relevant board event fires, tracks which cells changed since the last
 * snapshot (for flashing), and exposes a pause toggle. Matrix *semantics* are unchanged;
 * this only owns the refresh lifecycle.
 */
export function useLiveMultiRepoMatrix(
  activeProjectId: string | null,
  leadingRepoPath: string | null,
  columns: StatusWithIssues[],
): UseLiveMultiRepoMatrixResult {
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
        const [additionalRepos, allWorkspaces] = await Promise.all([
          apiFetch<ProjectRepoResponse[]>(`/api/projects/${activeProjectId}/repos`),
          apiFetch<SlimWorkspace[]>(
            `/api/workspaces?projectId=${activeProjectId}&status=${NON_CLOSED_WORKSPACE_STATUSES}`,
          ),
        ]);
        // repo-merge-status is not applicable to direct workspaces (400).
        const active = allWorkspaces.filter((w) => !w.isDirect);

        const statuses = await Promise.all(
          active.map((w) =>
            apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${w.id}/repo-merge-status`).catch(() => null),
          ),
        );
        // The conflict check runs real git merge-trees per repo — only pay for it on
        // workspaces that actually have unlanded work.
        const conflicts = await Promise.all(
          active.map((w, i) => {
            const st = statuses[i];
            if (!st?.repos.some((r) => r.hasWork && !r.merged)) return Promise.resolve(null);
            return apiFetch<{ hasConflicts: boolean }>(`/api/workspaces/${w.id}/conflicts`).catch(() => null);
          }),
        );

        // A newer refresh started while we were awaiting — drop this stale result.
        if (seq !== requestSeqRef.current) return;

        const issueById = new Map(columnsRef.current.flatMap((c) => c.issues).map((i) => [i.id, i]));
        const workspaces: MatrixWorkspaceInput[] = active.map((w, i) => {
          const issue = issueById.get(w.issueId);
          return {
            id: w.id,
            issueId: w.issueId,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            branch: w.branch,
            status: w.status,
            mergedAt: w.mergedAt,
            repoStatus: statuses[i],
            hasConflicts: conflicts[i]?.hasConflicts ?? false,
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
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  }, [activeProjectId, leadingRepoPath]);

  // Initial load (and reload when the project/leading repo changes).
  useEffect(() => {
    prevSnapshotRef.current = null;
    setChangedCells(new Set());
    load();
  }, [load]);

  // Coalesced live refresh: schedule one debounced load per burst of relevant events.
  const scheduleRefresh = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      load();
    }, REFRESH_DEBOUNCE_MS);
  }, [load]);

  // Subscribe to the existing board-events bus (re-dispatched as a window event by
  // useBoardEvents). No new WebSocket/endpoint — just a listener.
  useEffect(() => {
    if (!activeProjectId) return;
    const onBoardEvent = (e: Event) => {
      if (pausedRef.current) return;
      const detail = (e as CustomEvent<BoardWsEventDetail>).detail;
      if (!detail || detail.projectId !== activeProjectId) return;
      if (!RELEVANT_REASONS.has(detail.reason)) return;
      scheduleRefresh();
    };
    window.addEventListener(BOARD_WS_EVENT, onBoardEvent);
    return () => window.removeEventListener(BOARD_WS_EVENT, onBoardEvent);
  }, [activeProjectId, scheduleRefresh]);

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
