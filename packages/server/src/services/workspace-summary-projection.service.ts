import { existsSync } from "node:fs";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared";
import { getCommitCountAhead, getDiffShortstat, getLatestCommit } from "./git.service.js";
import {
  selectSummaryHealCandidates,
  updateWorkspaceSummaryGitProjection,
} from "../repositories/workspace-summary-projection.repository.js";
import { updateWorkspaceDiffStatCache } from "../repositories/workspace-summary.repository.js";
import type { Database } from "../db/index.js";

/**
 * #399 (decision 014) — the workspace-summary GIT PROJECTION.
 *
 * The two phase-4 git facts of `buildWorkspaceSummaryMap` (`git log -1` sha+subject and
 * `git rev-list --count base..HEAD`) persist on the workspace row (`summary_*` columns).
 * The board's hot path is then a pure projection read — zero git spawns, zero awaits —
 * while this module owns the only two code paths that recompute the facts:
 *   - the stale-while-revalidate refresh scheduled by the read path (`runBgGit` lane),
 *   - the bounded heal pass riding the 5-minute resource-sweep timer (monitor-setup),
 *     which repairs drift from board events (`summary_dirty`) and external git mutations.
 */

/** Freshness TTL for workspaces whose agent is running — same 30s cadence the old
 * in-memory gitOpsCache used, since an active agent commits at any time. */
export const ACTIVE_GIT_PROJECTION_TTL_MS = 30_000;
/** Freshness TTL for idle/blocked/etc. workspaces: their HEAD only moves through board
 * services (which mark dirty) or external hand-edits (healed by the reconcile pass). */
export const IDLE_GIT_PROJECTION_TTL_MS = 5 * 60_000;
/** Max rows the reconcile pass refreshes per 5-minute tick — bounded on purpose so a
 * 500-workspace board can never turn one tick into a spawn storm. */
export const SUMMARY_HEAL_BATCH_SIZE = 8;

export interface GitProjectionFreshnessFields {
  status: string;
  summaryDirty: boolean;
  summaryGitRefreshedAt: string | null;
}

/** Whether a row's persisted git facts can be served without scheduling a refresh. */
export function isGitProjectionFresh(row: GitProjectionFreshnessFields, nowMs: number): boolean {
  if (row.summaryDirty || !row.summaryGitRefreshedAt) return false;
  const age = nowMs - new Date(row.summaryGitRefreshedAt).getTime();
  const ttl = ACTIVE_WORKSPACE_STATUSES.has(row.status)
    ? ACTIVE_GIT_PROJECTION_TTL_MS
    : IDLE_GIT_PROJECTION_TTL_MS;
  return age < ttl;
}

export interface GitProjectionTarget {
  id: string;
  isDirect: boolean;
  workingDir: string | null;
  baseBranch: string | null;
  /** Last diff-stat cache SHA — a refresh that observes HEAD past it chains a diff-stat
   * refresh, preserving the "HEAD advanced → refresh diff" trigger that used to ride on
   * the inline phase-4 prefetch. */
  diffStatCacheHeadSha: string | null;
}

// Per-workspace in-flight guard: several board builds inside one TTL window (or a heal
// tick racing a read) must collapse to ONE git refresh, not queue duplicates.
const inFlightRefreshes = new Set<string>();

/**
 * Recompute the projection for one workspace and write it through (clearing dirty).
 * Never throws — refreshes are best-effort background work. A vanished workingDir writes
 * nulls WITH a fresh stamp, so the row stops being re-picked by every heal tick.
 */
export async function refreshWorkspaceGitProjection(
  ws: GitProjectionTarget,
  defaultBranch: string | null,
  database: Database,
): Promise<void> {
  if (inFlightRefreshes.has(ws.id)) return;
  inFlightRefreshes.add(ws.id);
  try {
    const now = () => new Date().toISOString();
    if (!ws.workingDir || !existsSync(ws.workingDir)) {
      await updateWorkspaceSummaryGitProjection(ws.id, {
        summaryHeadSha: null,
        summaryHeadMessage: null,
        summaryCommitCount: null,
        summaryGitRefreshedAt: now(),
      }, database);
      return;
    }
    const base = ws.isDirect ? null : (ws.baseBranch || defaultBranch);
    const [latest, commitCount] = await Promise.all([
      getLatestCommit(ws.workingDir),
      base ? getCommitCountAhead(ws.workingDir, base) : Promise.resolve(null),
    ]);
    await updateWorkspaceSummaryGitProjection(ws.id, {
      summaryHeadSha: latest?.sha ?? null,
      summaryHeadMessage: latest?.message ?? null,
      summaryCommitCount: commitCount,
      summaryGitRefreshedAt: now(),
    }, database);
    // HEAD advanced past the diff-stat cache → chain a diff-stat refresh (write-through,
    // same columns the applyDiffStats SWR path maintains).
    if (latest?.sha && latest.sha !== ws.diffStatCacheHeadSha) {
      const diffRef = ws.isDirect ? "HEAD" : base;
      if (diffRef) {
        const stats = await getDiffShortstat(ws.workingDir, diffRef).catch(() => null);
        if (stats) {
          await updateWorkspaceDiffStatCache(ws.id, {
            diffStatCacheCheckedAt: now(),
            diffStatCacheHeadSha: latest.sha,
            diffStatCacheFilesChanged: stats.filesChanged,
            diffStatCacheInsertions: stats.insertions,
            diffStatCacheDeletions: stats.deletions,
          }, database).catch(() => {});
        }
      }
    }
  } catch {
    // Best-effort: a failed refresh leaves the row dirty/stale for the next pass.
  } finally {
    inFlightRefreshes.delete(ws.id);
  }
}

/**
 * Reconcile pass (decision 014): refresh a bounded batch of the dirtiest projections —
 * dirty-flagged rows first, then the oldest stamps. Piggybacks the existing 5-minute
 * resource-sweep timer in monitor-setup; do NOT give it a timer of its own. Heals drift
 * from git mutations the board never saw (hand commits in a worktree) even when nobody
 * is reading the board. Never throws. Returns the number of rows refreshed.
 */
export async function healWorkspaceSummaryProjection(
  database: Database,
  opts: { limit?: number; now?: string } = {},
): Promise<number> {
  try {
    const limit = opts.limit ?? SUMMARY_HEAL_BATCH_SIZE;
    const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();
    const staleBefore = new Date(nowMs - IDLE_GIT_PROJECTION_TTL_MS).toISOString();
    const candidates = await selectSummaryHealCandidates(limit, staleBefore, database);
    for (const c of candidates) {
      await refreshWorkspaceGitProjection(c, c.defaultBranch, database);
    }
    return candidates.length;
  } catch (err) {
    console.warn("[summary-projection] heal pass failed:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
