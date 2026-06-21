import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { checkBranchTipIsAncestor, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { PREF_RECONCILER_ANCESTOR_BRANCH_ENABLED } from "../constants/preference-keys.js";
import { finalizeMergeCleanup } from "../services/merge-cleanup.service.js";

/** Issue status names that are already terminal; skip these workspaces. */
const TERMINAL_STATUS_NAMES = ["Done", "AI Reviewed", "Closed", "Cancelled"];

export interface AncestorBranchReconcilerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
  /** Injectable for testing. Defaults to the real countUniqueCommits from git-service. */
  countCommits?: typeof countUniqueCommits;
  /**
   * Override enabled state for testing. When undefined (production path), the reconciler
   * reads the live `reconciler_ancestor_branch_enabled` preference from the DB at call time,
   * so a source-level or pref-level disable takes effect on the next tick with no restart.
   */
  enabled?: boolean;
  /**
   * Override the timer callback for testing. When provided, replaces the default tick
   * (which calls reconcileAncestorBranchWorkspaces) so tests can verify the interval
   * stops firing without needing a real DB or git setup.
   */
  onTick?: () => void;
}

/**
 * Reconcile workspaces whose branch tip is already an ancestor of the base
 * branch (i.e. the work was genuinely merged into base) but whose issue is
 * still stuck in a non-terminal status (e.g. "In Review" or "In Progress").
 *
 * This happens when the merge HTTP response was interrupted after the git
 * operation completed but before the DB was updated — the DB never recorded
 * `mergedAt`, so `reconcileSilentlyMergedWorkspaces` (which checks mergedAt)
 * cannot catch it. This reconciler catches it by asking git directly.
 *
 * Complementary safety net: `reconcileSilentlyMergedWorkspaces` handles the
 * case where mergedAt is set; this handles the case where git says merged but
 * mergedAt is null.
 *
 * Idempotent: once the workspace is closed and the issue is Done, subsequent
 * runs find the issue in a terminal status and skip it.
 */
export async function reconcileAncestorBranchWorkspaces(
  deps: AncestorBranchReconcilerDeps = {},
): Promise<number> {
  const database = deps.database ?? db;
  const ancestorCheck = deps.checkAncestor ?? checkBranchTipIsAncestor;
  const commitCounter = deps.countCommits ?? countUniqueCommits;

  // Live pref read at every tick so disabling via pref takes effect without a restart.
  // The `enabled` override in deps lets tests inject the state directly.
  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : await (async () => {
        try {
          const row = await database.select({ value: preferences.value }).from(preferences)
            .where(eq(preferences.key, PREF_RECONCILER_ANCESTOR_BRANCH_ENABLED)).limit(1);
          return row.length === 0 || row[0].value !== "false";
        } catch {
          return true;
        }
      })();
  if (!isEnabled) {
    console.log("[ancestor-reconciler] disabled via preference — skipping tick");
    return 0;
  }

  // Find non-closed, non-direct workspaces whose issue is NOT in a terminal status
  // and whose mergedAt is null (mergedAt set = already handled by reconcileSilentlyMergedWorkspaces).
  // In Progress is only eligible when idle+readyForMerge=true: that flag comes
  // from the review flow, and a dropped merge response can leave reviewed work
  // parked in that column. Running In Progress work may have uncommitted changes
  // even when the current branch tip is already an ancestor.
  const candidates = await database
    .select({
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      workingDir: workspaces.workingDir,
      wsStatus: workspaces.status,
      readyForMerge: workspaces.readyForMerge,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      repoPath: projects.repoPath,
      statusName: projectStatuses.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(
      and(
        ne(workspaces.status, "closed"),
        eq(workspaces.isDirect, false),
        isNull(workspaces.mergedAt),
        notInArray(projectStatuses.name, TERMINAL_STATUS_NAMES),
      ),
    );

  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const now = new Date().toISOString();

  for (const c of candidates) {
    if (!c.branch || !c.baseBranch || !c.repoPath) continue;
    if (c.statusName === "In Progress" && (!c.readyForMerge || c.wsStatus !== "idle")) continue;

    let result: Awaited<ReturnType<typeof checkBranchTipIsAncestor>>;
    try {
      result = await ancestorCheck(c.repoPath, c.branch, c.baseBranch, c.workingDir ?? undefined);
    } catch (err) {
      console.warn(`[ancestor-reconciler] git check failed for workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (!result.isAncestor) continue;

    // A 0-commit workspace has no unique commits (branchSha === baseSha for a
    // fresh branch, or rev-list count==0 when the base advanced past an empty
    // branch). Never reconcile these — they have no real merged work.
    let uniqueCommits: number;
    try {
      uniqueCommits = await commitCounter(c.repoPath, result.baseSha, result.branchSha);
    } catch {
      uniqueCommits = 0;
    }
    if (uniqueCommits === 0) {
      console.log(
        `[ancestor-reconciler] workspace ${c.wsId} (issue #${c.issueNumber ?? "?"}, branch=${c.branch}) — 0 unique commits on branch; skipping`,
      );
      continue;
    }

    console.log(
      `[ancestor-reconciler] workspace ${c.wsId} (issue #${c.issueNumber ?? "?"}, branch=${c.branch}) — branch tip is ancestor of ${c.baseBranch} but issue is '${c.statusName}'; reconciling`,
    );

    try {
      const mergedAt = now;
      await finalizeMergeCleanup({
        database,
        workspaceId: c.wsId,
        issueId: c.issueId,
        now,
        mergedAt,
        closedAt: now,
        workingDir: null,
        projectId: c.projectId,
      });

      console.log(
        `[ancestor-reconciler] auto-Done audit: issue=${c.issueNumber ?? "?"} ws=${c.wsId} baseSha=${result.baseSha} branchSha=${result.branchSha} uniqueCommits=${uniqueCommits} reconciledAt=${now}`,
      );
      try {
        await logBoardHealthEvent({
          projectId: c.projectId,
          cycleId: `ancestor-reconcile-${c.wsId}`,
          eventType: "action",
          category: "merge",
          issueNumber: c.issueNumber ?? undefined,
          summary: `Ancestor-branch reconciliation: workspace ${c.branch} branch tip was already merged into ${c.baseBranch} but issue was '${c.statusName}'. Closed workspace and moved issue to Done.`,
          details: { workspaceId: c.wsId, branchSha: result.branchSha, baseSha: result.baseSha, uniqueCommitCount: uniqueCommits, reconciledAt: now },
        }, database);
      } catch { /* health event logging is non-fatal */ }

      reconciled++;
    } catch (err) {
      console.warn(`[ancestor-reconciler] failed to reconcile workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
    }
  }

  if (reconciled > 0) {
    console.log(`[ancestor-reconciler] reconciled ${reconciled} stranded workspace(s) whose branch was already merged`);
  }
  return reconciled;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let activeAncestorTimeout: ReturnType<typeof setTimeout> | null = null;
let activeAncestorInterval: ReturnType<typeof setInterval> | null = null;

export function stopAncestorBranchReconciler(): void {
  if (activeAncestorTimeout !== null) {
    clearTimeout(activeAncestorTimeout);
    activeAncestorTimeout = null;
  }
  if (activeAncestorInterval !== null) {
    clearInterval(activeAncestorInterval);
    activeAncestorInterval = null;
  }
}

/**
 * Schedule the ancestor-branch reconciler to run shortly after boot and then periodically.
 *
 * Both handles are unref'd so they don't prevent the process from exiting cleanly.
 * Returns both handles so callers can clearTimeout/clearInterval them if needed.
 *
 * Hot-reload-safe: the tick reads the live `reconciler_ancestor_branch_enabled` preference
 * at call time, so even if tsx --watch keeps an old interval alive, the disabled pref
 * causes it to no-op on every subsequent tick.
 */
export function startAncestorBranchReconciler(
  deps: Omit<AncestorBranchReconcilerDeps, "enabled"> = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): { timer: NodeJS.Timeout; interval: NodeJS.Timeout } {
  stopAncestorBranchReconciler();

  const tick = deps.onTick ?? (() => {
    reconcileAncestorBranchWorkspaces(deps).catch((err) =>
      console.warn("[ancestor-reconciler] periodic tick error:", err instanceof Error ? err.message : err),
    );
  });
  const timer = setTimeout(tick, 35_000);
  const interval = setInterval(tick, intervalMs);
  activeAncestorTimeout = timer;
  activeAncestorInterval = interval;
  (timer).unref?.();
  (interval).unref?.();
  return { timer, interval };
}
