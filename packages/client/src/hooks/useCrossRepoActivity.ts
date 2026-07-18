import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoMergeStatusResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";
import {
  reduceRepoMergeStatusDelta,
  reduceConflictsDelta,
  appendActivityEntries,
  type CrossRepoActivityEntry,
} from "../lib/crossRepoActivity.js";

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
  mergedAt: string | null;
  isDirect: boolean;
}

/** Non-terminal statuses worth watching — same allowlist the #82 monitor uses. */
const NON_CLOSED_WORKSPACE_STATUSES = [
  "active", "idle", "blocked", "reviewing", "fixing", "ready_for_merge", "awaiting-plan-approval", "error",
].join(",");

/**
 * WS `board_changed` reasons that can move cross-repo state (a merge landing, a
 * session/workflow step, a drive obstacle) and so warrant re-snapshotting. Plus the
 * WS lifecycle reasons ("reconnect"/"poll") that already fire a board refresh.
 */
function shouldRefetch(reason: string): boolean {
  return (
    reason === "reconnect" ||
    reason === "poll" ||
    reason.startsWith("workspace_merged") ||
    reason.startsWith("session") ||
    reason.startsWith("workflow") ||
    reason.startsWith("drive_obstacle") ||
    reason.includes("merge") ||
    reason.includes("conflict")
  );
}

interface Snapshot {
  mergeStatus: RepoMergeStatusResponse | null;
  conflictFiles: string[] | null;
  /** Issue this workspace belongs to — retained so a workspace that MERGES (and thus
   *  leaves the non-closed set) can still be resolved for its terminal merge entry. */
  issueId: string;
}

export interface UseCrossRepoActivityResult {
  entries: CrossRepoActivityEntry[];
  loading: boolean;
  /** True once at least one multi-repo workspace has been observed. */
  multiRepo: boolean;
  refresh: () => void;
}

/**
 * Live cross-repo activity feed (#88). Snapshots each non-direct workspace's
 * per-repo merge status + conflicts, and on relevant board-events WS reasons
 * re-fetches and diffs against the stored snapshot, appending repo-labeled entries
 * for each transition (merge / stranded / advance / conflict appear/clear). Read-only
 * over existing endpoints — no schema changes.
 */
export function useCrossRepoActivity(
  projectId: string | null,
  resolveIssue?: (issueId: string) => { issueNumber: number | null } | undefined,
): UseCrossRepoActivityResult {
  const [entries, setEntries] = useState<CrossRepoActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [multiRepo, setMultiRepo] = useState(false);
  const snapshotsRef = useRef<Map<string, Snapshot>>(new Map());
  const inFlightRef = useRef(false);
  const resolveIssueRef = useRef(resolveIssue);
  resolveIssueRef.current = resolveIssue;

  const refresh = useCallback(async () => {
    if (!projectId || inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const workspaces = await apiFetch<SlimWorkspace[]>(
        `/api/workspaces?projectId=${projectId}&status=${NON_CLOSED_WORKSPACE_STATUSES}`,
      );
      const active = workspaces.filter((w) => !w.isDirect);
      const timestamp = new Date().toISOString();
      const newEntries: CrossRepoActivityEntry[] = [];
      let sawMultiRepo = false;

      await Promise.all(
        active.map(async (w) => {
          const mergeStatus = await apiFetch<RepoMergeStatusResponse>(
            `/api/workspaces/${w.id}/repo-merge-status`,
          ).catch(() => null);
          // Single-repo (<=1) and direct/older-server workspaces contribute nothing.
          if (!mergeStatus || mergeStatus.repos.length <= 1) return;
          sawMultiRepo = true;

          // Only pay for the per-repo conflict merge-trees when there is unlanded work.
          const hasUnlanded = mergeStatus.repos.some((r) => r.hasWork && !r.merged);
          const conflictFiles = hasUnlanded
            ? await apiFetch<{ hasConflicts: boolean; conflictingFiles: string[] }>(
                `/api/workspaces/${w.id}/conflicts`,
              ).then((c) => c.conflictingFiles ?? []).catch(() => null)
            : [];

          const prev = snapshotsRef.current.get(w.id) ?? { mergeStatus: null, conflictFiles: null, issueId: w.issueId };
          const issue = resolveIssueRef.current?.(w.issueId);
          const ctx = {
            workspaceId: w.id,
            issueId: w.issueId,
            issueNumber: issue?.issueNumber ?? null,
            timestamp,
            baseBranch: mergeStatus.baseBranch,
          };
          newEntries.push(...reduceRepoMergeStatusDelta(prev.mergeStatus, mergeStatus, ctx));
          if (conflictFiles !== null) {
            newEntries.push(...reduceConflictsDelta(prev.conflictFiles, conflictFiles, ctx));
          }
          snapshotsRef.current.set(w.id, {
            mergeStatus,
            conflictFiles: conflictFiles ?? prev.conflictFiles,
            issueId: w.issueId,
          });
        }),
      );

      // A workspace that just MERGED leaves the non-closed set entirely, so its repos
      // never flip to "merged" while it is in `active` — the headline "repo merged"
      // entry (acceptance #1) would never fire. Catch it: any workspace we were tracking
      // that is now gone from the active set AND last showed unlanded work gets ONE final
      // repo-merge-status fetch (the endpoint resolves closed workspaces too) so the
      // ahead/stranded → merged transition is emitted, then is dropped from tracking —
      // bounding this to at most one extra fetch per merge.
      const activeIds = new Set(active.map((w) => w.id));
      const vanished = [...snapshotsRef.current.entries()].filter(
        ([wsId, snap]) =>
          !activeIds.has(wsId) && (snap.mergeStatus?.repos.some((r) => r.hasWork && !r.merged) ?? false),
      );
      await Promise.all(
        vanished.map(async ([wsId, snap]) => {
          const finalStatus = await apiFetch<RepoMergeStatusResponse>(
            `/api/workspaces/${wsId}/repo-merge-status`,
          ).catch(() => null);
          snapshotsRef.current.delete(wsId); // one-shot — a departed workspace is not rescanned
          if (!finalStatus) return;
          const issue = resolveIssueRef.current?.(snap.issueId);
          newEntries.push(
            ...reduceRepoMergeStatusDelta(snap.mergeStatus, finalStatus, {
              workspaceId: wsId,
              issueId: snap.issueId,
              issueNumber: issue?.issueNumber ?? null,
              timestamp,
              baseBranch: finalStatus.baseBranch,
            }),
          );
        }),
      );

      if (sawMultiRepo) setMultiRepo(true);
      if (newEntries.length > 0) {
        setEntries((existing) => appendActivityEntries(existing, newEntries));
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [projectId]);

  // Initial baseline snapshot (emits nothing) + live re-snapshot on relevant WS reasons.
  useEffect(() => {
    if (!projectId) return;
    void refresh();
    const onWsEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<BoardWsEventDetail>).detail;
      if (!detail || detail.projectId !== projectId) return;
      if (shouldRefetch(detail.reason)) void refresh();
    };
    window.addEventListener(BOARD_WS_EVENT, onWsEvent);
    return () => window.removeEventListener(BOARD_WS_EVENT, onWsEvent);
  }, [projectId, refresh]);

  // Reset accumulated state when the project changes.
  useEffect(() => {
    snapshotsRef.current = new Map();
    setEntries([]);
    setMultiRepo(false);
  }, [projectId]);

  return { entries, loading, multiRepo, refresh: () => void refresh() };
}
