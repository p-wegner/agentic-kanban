import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RepoMergeStatusResponse, WorkspaceHandoffResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { fetchWorkspaceRepoStatus } from "../lib/workspaceRepoStatusQuery.js";
import {
  reduceRepoMergeStatusDelta,
  reduceConflictsDelta,
  reduceHandoffDelta,
  appendActivityEntries,
  type CrossRepoActivityEntry,
} from "../lib/crossRepoActivity.js";
import { LEADING_REPO_LABEL } from "../lib/groupConflictsByRepo.js";
import { useBoardWsRefresh } from "./useBoardWsRefresh.js";
import { SESSION_LIFECYCLE_REASONS, WORKFLOW_REASONS, type ClientRefreshReason } from "@agentic-kanban/shared/lib/board-events-contract";

/**
 * WS `board_changed` reasons that can move cross-repo state (a merge landing, a
 * session/workflow step, a drive obstacle) and so warrant re-snapshotting.
 * "reconnect"/"poll" are deliberately excluded (perf review 2026-08-11): a flapping
 * server produces a reconnect storm, and each re-snapshot is a slow /api/workspaces
 * fan-out — amplifying exactly the load that made the server flap.
 */
/**
 * #566: was six string tests over an untyped reason, one of which
 * (`reason.includes("conflict")`) matched NOTHING — no reason has ever contained
 * "conflict". Set membership over the shared vocabulary; same members minus that one.
 */
const CROSS_REPO_ACTIVITY_REASONS: ReadonlySet<ClientRefreshReason> = new Set<ClientRefreshReason>([
  ...SESSION_LIFECYCLE_REASONS,
  ...WORKFLOW_REASONS,
  "workspace_merged",
  "workspace_ready_for_merge",
  "drive_obstacle",
]);

function shouldRefetch(reason: ClientRefreshReason): boolean {
  return CROSS_REPO_ACTIVITY_REASONS.has(reason);
}

interface Snapshot {
  mergeStatus: RepoMergeStatusResponse | null;
  conflictFiles: string[] | null;
  /** Last-observed HANDOFF.md snapshot (null = never observed → handoff baseline). */
  handoff: WorkspaceHandoffResponse | null;
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
  const queryClient = useQueryClient();
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
      // #415 — ONE batched request (shared react-query, deduped with the matrix /
      // heatmap panels) carries merge status + conflicts + handoff for every
      // non-closed, non-direct workspace; the old code fanned out three requests
      // per workspace per burst.
      const batch = await fetchWorkspaceRepoStatus(queryClient, projectId);
      const active = batch.workspaces;
      const timestamp = new Date().toISOString();
      const newEntries: CrossRepoActivityEntry[] = [];
      let sawMultiRepo = false;

      for (const w of active) {
        const mergeStatus = w.mergeStatus;
        // Single-repo (<=1) workspaces contribute nothing.
        if (!mergeStatus || mergeStatus.repos.length <= 1) continue;
        sawMultiRepo = true;

        // The batch only pays for the conflict merge-trees when there is unlanded
        // work; a workspace with everything landed reports the empty shape.
        const conflictFiles = w.conflicts ? (w.conflicts.conflictingFiles ?? []) : null;
        const handoff = w.handoff;

        const prev = snapshotsRef.current.get(w.workspaceId) ?? { mergeStatus: null, conflictFiles: null, handoff: null, issueId: w.issueId };
        const issue = resolveIssueRef.current?.(w.issueId);
        const ctx = {
          workspaceId: w.workspaceId,
          issueId: w.issueId,
          issueNumber: issue?.issueNumber ?? null,
          timestamp,
          baseBranch: mergeStatus.baseBranch,
        };
        newEntries.push(...reduceRepoMergeStatusDelta(prev.mergeStatus, mergeStatus, ctx));
        if (conflictFiles !== null) {
          newEntries.push(...reduceConflictsDelta(prev.conflictFiles, conflictFiles, ctx));
        }
        if (handoff) {
          // `prev.handoff === null` (workspace never handoff-observed) → pass `undefined`
          // so the first snapshot is a baseline, not a replay of an existing HANDOFF.md.
          const prevByRepo = new Map((prev.handoff?.repos ?? []).map((r) => [r.name, r.updatedAt] as const));
          for (const repoEntry of handoff.repos) {
            const label = repoEntry.name ?? LEADING_REPO_LABEL;
            const prevMtime = prev.handoff === null ? undefined : (prevByRepo.get(repoEntry.name) ?? null);
            newEntries.push(...reduceHandoffDelta(prevMtime, repoEntry, label, ctx));
          }
        }
        snapshotsRef.current.set(w.workspaceId, {
          mergeStatus,
          conflictFiles: conflictFiles ?? prev.conflictFiles,
          handoff: handoff ?? prev.handoff,
          issueId: w.issueId,
        });
      }

      // A workspace that just MERGED leaves the non-closed set entirely, so its repos
      // never flip to "merged" while it is in `active` — the headline "repo merged"
      // entry (acceptance #1) would never fire. Catch it: any workspace we were tracking
      // that is now gone from the active set AND last showed unlanded work gets ONE final
      // repo-merge-status fetch (the endpoint resolves closed workspaces too) so the
      // ahead/stranded → merged transition is emitted, then is dropped from tracking —
      // bounding this to at most one extra fetch per merge.
      const activeIds = new Set(active.map((w) => w.workspaceId));
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
  }, [projectId, queryClient]);

  // Initial baseline snapshot (emits nothing) + live re-snapshot on relevant WS reasons.
  // Trailing 250ms debounce per burst; and because `refresh` early-returns while a
  // snapshot is in flight (inFlightRef), an event arriving mid-flight used to be
  // silently DROPPED — the debounce timer re-checks after the flight so a burst
  // always ends with one trailing re-snapshot.
  useEffect(() => {
    if (!projectId) return;
    void refresh();
  }, [projectId, refresh]);

  // #514: the debounce + re-arm-while-in-flight logic that used to live here is the
  // controller's job now. `refresh` still guards itself with inFlightRef, so a call that
  // arrives mid-snapshot is a no-op there; the controller is what makes sure the event
  // is not simply LOST in that case — it re-arms once the in-flight call settles.
  useBoardWsRefresh({ projectId, shouldRefetch, refresh });

  // Reset accumulated state when the project changes.
  useEffect(() => {
    snapshotsRef.current = new Map();
    setEntries([]);
    setMultiRepo(false);
  }, [projectId]);

  return { entries, loading, multiRepo, refresh: () => void refresh() };
}
