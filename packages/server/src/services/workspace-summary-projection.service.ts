import { existsSync } from "node:fs";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared";
import * as realGitService from "./git.service.js";
import { getCommitCountAhead, getDiffShortstat, getLatestCommit } from "./git.service.js";
import {
  selectRepoSummaryHealCandidates,
  selectSummaryHealCandidates,
  updateRepoSummaryProjection,
  updateWorkspaceSummaryGitProjection,
} from "../repositories/workspace-summary-projection.repository.js";
import { updateWorkspaceDiffStatCache } from "../repositories/workspace-summary.repository.js";
import { notifySummaryWriteThrough } from "./summary-write-through-notifier.js";
import type { Database } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
  /** Previously projected values (G13) — a refresh only invalidates the board ETag
   * generation when the facts it writes actually MOVED, so steady-state TTL refreshes
   * that rewrite identical facts never thrash the conditional-GET memo. */
  summaryHeadSha: string | null;
  summaryCommitCount: number | null;
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
      // G13: a vanished worktree that previously projected facts is a visible change.
      if (ws.summaryHeadSha !== null || ws.summaryCommitCount !== null) {
        notifySummaryWriteThrough(ws.id);
      }
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
    // G13: write-through landed — bump the board ETag generation only when the
    // projected facts moved (change gate; see summary-write-through-notifier.ts).
    if ((latest?.sha ?? null) !== ws.summaryHeadSha || commitCount !== ws.summaryCommitCount) {
      notifySummaryWriteThrough(ws.id);
    }
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

// ─── #415: the per-repo merge-status projection (repos.summary_*, migration 0118) ───

/** Minimal git surface the per-repo projection needs — satisfied by the full GitService. */
export interface RepoProjectionGit {
  revParse(repoPath: string, ref: string): Promise<string>;
  countUniqueCommits(repoPath: string, baseSha: string, branchSha: string): Promise<number>;
}

/** The repo fields the per-repo projection reads/writes (a subset of WorkspaceRepoRef
 * and of the heal candidates — both satisfy it structurally). */
export interface RepoProjectionRef {
  path: string;
  branch: string | null;
  baseBranch: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
  projectionRowId: string | null;
  summaryDirty: boolean | null;
  summaryGitRefreshedAt: string | null;
}

/**
 * #415 — whether a repos row's persisted `summary_ahead`/`summary_historic` can answer
 * its merge-status entry without any git spawn. Mirrors the decision-014 freshness rule:
 * never fresh when dirty (or rowless / never-refreshed), status-dependent TTL — an
 * ACTIVE workspace commits at any time; an idle one's git state only moves through
 * board services, which mark dirty.
 */
export function isRepoProjectionFresh(
  ref: Pick<RepoProjectionRef, "summaryDirty" | "summaryGitRefreshedAt">,
  workspaceStatus: string | undefined,
  nowMs: number,
): boolean {
  if (ref.summaryDirty !== false || !ref.summaryGitRefreshedAt) return false;
  const ttl = workspaceStatus && ACTIVE_WORKSPACE_STATUSES.has(workspaceStatus)
    ? ACTIVE_GIT_PROJECTION_TTL_MS
    : IDLE_GIT_PROJECTION_TTL_MS;
  return nowMs - new Date(ref.summaryGitRefreshedAt).getTime() < ttl;
}

/**
 * #415 — the LIVE per-repo computation (the projection's single recompute path, shared
 * by the read fallback in repo-merge-status and the heal pass below):
 *   ahead    = commits on `branch` not on `baseBranch` (guarded revParse; gone refs → 0)
 *   historic = when 0-ahead, commits between the original cut point and the live tip
 *              (else the stamped tip) — the "had work, now landed" signal.
 * When `database` is passed and the ref has a backing row, the result is written
 * through (freshness stamped, dirty cleared) so the next read within TTL is spawn-free.
 */
export async function computeRepoAheadHistoric(
  ref: RepoProjectionRef,
  gitService: RepoProjectionGit,
  database?: Database,
): Promise<{ ahead: number; historic: number }> {
  let ahead = 0;
  if (ref.branch && ref.baseBranch) {
    try {
      await gitService.revParse(ref.path, ref.baseBranch);
      await gitService.revParse(ref.path, ref.branch);
      ahead = await gitService.countUniqueCommits(ref.path, ref.baseBranch, ref.branch).catch(() => 0);
    } catch { /* branch/base ref gone (e.g. cleaned up) → no countable work */ }
  }
  let historic = 0;
  if (ahead === 0 && ref.baseCommitSha) {
    let tip: string | null = null;
    if (ref.branch && (await gitService.revParse(ref.path, ref.branch).then(() => true).catch(() => false))) {
      tip = ref.branch;
    } else if (ref.mergedHeadSha) {
      tip = ref.mergedHeadSha;
    }
    if (tip) historic = await gitService.countUniqueCommits(ref.path, ref.baseCommitSha, tip).catch(() => 0);
  }
  if (database && ref.projectionRowId) {
    await updateRepoSummaryProjection(ref.projectionRowId, {
      summaryAhead: ahead,
      summaryHistoric: historic,
      summaryGitRefreshedAt: new Date().toISOString(),
    }, database).catch(() => {});
  }
  return { ahead, historic };
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
    // #415 — the same tick also heals a bounded batch of PER-REPO projections
    // (repos.summary_*), so sibling merge-status facts recover from external git
    // mutations even when nobody is reading the cross-repo panels. Rows whose repo
    // root vanished are stamped as no-work (fresh) so they stop being re-picked.
    const repoCandidates = await selectRepoSummaryHealCandidates(limit, staleBefore, database);
    for (const c of repoCandidates) {
      if (!existsSync(c.path)) {
        await updateRepoSummaryProjection(c.rowId, {
          summaryAhead: 0,
          summaryHistoric: 0,
          summaryGitRefreshedAt: new Date().toISOString(),
        }, database).catch(() => {});
        continue;
      }
      await computeRepoAheadHistoric(
        { ...c, projectionRowId: c.rowId },
        realGitService,
        database,
      );
    }
    return candidates.length + repoCandidates.length;
  } catch (err) {
    console.warn("[summary-projection] heal pass failed:", errorMessage(err));
    return 0;
  }
}
