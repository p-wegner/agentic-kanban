import { existsSync } from "node:fs";
import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { checkBranchTipIsAncestor, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { PREF_RECONCILER_ANCESTOR_BRANCH_ENABLED } from "../constants/preference-keys.js";
import { finalizeMergeCleanup } from "../services/merge-cleanup.service.js";
import * as realGitService from "../services/git.service.js";
import {
  listPendingSiblingMerges,
  checkPendingSiblingMergeGuards,
  type GitService,
  type PendingSiblingMerge,
} from "../services/workspace-internals.js";
import { executeSiblingMerges, cleanupSiblingWorktrees, stampReconciledLeadingMerge } from "../services/workspace-repos.service.js";
import { createBackup } from "../db/backup.js";
import { reconcileSilentlyMergedWorkspaces } from "./silently-merged-reconciler.js";

/** Issue status names that are already terminal; skip these workspaces. */
const TERMINAL_STATUS_NAMES = ["Done", "AI Reviewed", "Closed", "Cancelled"];

/**
 * Max candidates allowed to reach the git-spawning phase per pass (#277).
 *
 * This reconciler runs during startup, BEFORE the HTTP listener binds, and each
 * candidate costs an ancestry check plus a commit count — synchronous CreateProcess
 * work on the event-loop thread. With a large workspace table that is added straight
 * onto time-to-first-response. Deferred candidates are picked up on the next pass.
 */
const MAX_GIT_CANDIDATES_PER_PASS = 25;

export interface AncestorBranchReconcilerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
  /** Injectable for testing. Defaults to the real countUniqueCommits from git-service. */
  countCommits?: typeof countUniqueCommits;
  /**
   * On-disk presence probe for a candidate's repo path (#277). Defaults to `existsSync`;
   * suites using synthetic repo paths inject `() => true`.
   */
  pathExists?: (path: string) => boolean;
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
  /**
   * Injectable full git-service module (sibling checks need more surface than the
   * ancestor/commit-count functions alone). Defaults to the real server git.service.
   */
  gitService?: GitService;
}

/** Record a merge-attempt comment on the issue, mirroring reconcileStrandedSiblingMerges. */
async function recordSiblingComment(
  database: Database,
  candidate: { wsId: string; issueId: string; branch: string },
  eventType: "merged" | "conflict",
  body: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await insertIssueComment({
    issueId: candidate.issueId,
    workspaceId: candidate.wsId,
    kind: "merge-attempt",
    author: "system",
    body,
    payload: { eventType, workspaceId: candidate.wsId, branch: candidate.branch, ...payload },
    createdAt: new Date().toISOString(),
  }, database).catch((err) => {
    console.warn("[ancestor-reconciler] failed to record issue comment:", err instanceof Error ? err.message : String(err));
  });
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
  const gitSvc = deps.gitService ?? realGitService;
  // Injectable so suites driving fake git over synthetic repo paths keep testing the
  // git-level semantics instead of tripping the missing-repo short-circuit (#277).
  const pathExists = deps.pathExists ?? existsSync;

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

  let gitBudgetUsed = 0;
  let deferred = 0;
  for (const c of candidates) {
    if (!c.branch || !c.baseBranch || !c.repoPath) continue;
    if (c.statusName === "In Progress" && (!c.readyForMerge || c.wsStatus !== "idle")) continue;
    // Repo gone → every git call below can only fail. A stat beats a ~120ms spawn,
    // and this ran for every candidate on every pass (#277).
    if (!pathExists(c.repoPath)) continue;

    // This reconciler runs BEFORE the HTTP listener binds, so its cost is added
    // directly to "the board takes minutes to load". Bound the git work per pass;
    // the remainder is picked up next pass (reconciled workspaces are stamped, so
    // progress is monotonic and this converges).
    if (gitBudgetUsed >= MAX_GIT_CANDIDATES_PER_PASS) {
      deferred++;
      continue;
    }
    gitBudgetUsed++;

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

    // Sibling-aware terminalization (#151): the leading branch alone converging to an
    // ancestor of base does NOT mean the whole multi-repo workspace is done — a sibling
    // repo may still hold unlanded work. Consult listPendingSiblingMerges (the shared
    // "is the workspace REALLY fully merged?" probe) before terminalizing; if any sibling
    // is pending, land it through the same guarded pipeline reconcileStrandedSiblingMerges
    // uses instead of Done-ing the issue with the sibling stranded.
    let pendingSiblings: PendingSiblingMerge[] = [];
    try {
      pendingSiblings = await listPendingSiblingMerges(gitSvc, database, c.wsId);
    } catch (err) {
      console.warn(
        `[ancestor-reconciler] pending-sibling scan failed for workspace ${c.wsId} (proceeding as no-siblings):`,
        err instanceof Error ? err.message : err,
      );
    }

    if (pendingSiblings.length > 0) {
      console.warn(
        `[ancestor-reconciler] workspace ${c.wsId} leading branch is an ancestor of ${c.baseBranch}, but ${pendingSiblings.length} sibling repo(s) still have unmerged commits — landing siblings before terminalizing`,
      );
      const guardFailures = await checkPendingSiblingMergeGuards(gitSvc, pendingSiblings);
      if (guardFailures.length > 0) {
        console.warn(`[ancestor-reconciler] cannot land sibling merge(s) for workspace ${c.wsId}: ${guardFailures.join("; ")}`);
        await recordSiblingComment(database, c, "conflict",
          `Ancestor-branch reconciliation found the leading branch ${c.branch} already merged into ${c.baseBranch}, but ${pendingSiblings.length} sibling repo(s) still have unmerged commits and could not be landed automatically: ` +
            guardFailures.join("; ") +
            ". Leaving the issue open — resolve the blockers and merge the siblings manually, or retry the workspace merge.",
          { mergeReason: "sibling_merge_pending", failures: guardFailures, detectedAt: now });
        continue;
      }

      const siblingResults = await executeSiblingMerges({ gitService: gitSvc, database, createBackup, workspaceId: c.wsId, plans: pendingSiblings });
      const failedSiblings = siblingResults.filter((r) => !r.merged);
      if (failedSiblings.length > 0) {
        console.warn(`[ancestor-reconciler] ${failedSiblings.length} sibling merge(s) failed for workspace ${c.wsId}`);
        await recordSiblingComment(database, c, "conflict",
          `Ancestor-branch reconciliation: leading branch ${c.branch} was already merged into ${c.baseBranch}, but ${failedSiblings.length} sibling repo merge(s) failed: ` +
            failedSiblings.map((f) => `${f.name ?? f.path}: ${f.error}`).join("; ") +
            ". Leaving the issue open — the unmerged sibling branches were preserved.",
          { mergeReason: "sibling_merge_failed", siblingResults, detectedAt: now });
        continue;
      }

      console.log(`[ancestor-reconciler] landed ${siblingResults.length} sibling merge(s) for workspace ${c.wsId} before finalizing`);
      await recordSiblingComment(database, c, "merged",
        `Ancestor-branch reconciliation: landed ${siblingResults.length} sibling repo merge(s) alongside the already-merged leading branch ${c.branch}: ` +
          siblingResults.map((r) => r.name ?? r.path).join(", ") + ".",
        { siblingResults, reconciledAt: now });
    }

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

      // Mirror of the sibling stamp above (#114/#115 pattern): the leading branch
      // converged to an ancestor of base on its own (hand-merged / interrupted-response
      // path), so closeWorkspace stamped mergedAt but never mergedHeadSha. Record the
      // landed leading tip now — before any later cleanup — so getRepoMergeStatus reads
      // the leading repo as merged instead of falsely `hasWork:false / merged:false`.
      // No-op for a sibling-only ticket (0 leading historic commits) or an already-stamped row.
      try {
        await stampReconciledLeadingMerge({ gitService: gitSvc, database, workspaceId: c.wsId, now });
      } catch (err) {
        console.warn(`[ancestor-reconciler] leading mergedHeadSha stamp failed (non-fatal) for workspace ${c.wsId}:`, err instanceof Error ? err.message : String(err));
      }

      if (pendingSiblings.length > 0) {
        // Sibling worktrees + branches can now be dropped; preserveUnmerged re-verifies
        // per repo so a merge that failed post-guard-check is never destroyed.
        await cleanupSiblingWorktrees(gitSvc, c.wsId, database, { preserveUnmerged: true });
      }

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
  if (deferred > 0) {
    console.log(
      `[ancestor-reconciler] git budget reached (${MAX_GIT_CANDIDATES_PER_PASS} candidates); ` +
      `${deferred} candidate(s) deferred to the next pass`,
    );
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
 * Run the stranded-sibling compensator (merge-workflow.ts's reconcileStrandedSiblingMerges)
 * once. Previously wired ONLY into startup (startup-tasks.ts) — recovery from a partial
 * sibling merge (doMerge/autoMerge close the workspace even when sibling merges fail
 * post-prevalidation) only happened on server restart. Shared onto the ancestor-branch
 * reconciler's periodic cadence (#151) so it self-heals within one tick instead of waiting
 * for the next boot. Dynamically imported: merge-workflow pulls in the whole merge
 * pipeline, which the ancestor reconciler otherwise doesn't need at module load.
 */
export async function runStrandedSiblingCompensatorTick(database?: Database): Promise<void> {
  try {
    const { reconcileStrandedSiblingMerges } = await import("./merge-workflow.js");
    await reconcileStrandedSiblingMerges(database);
  } catch (err) {
    console.warn("[ancestor-reconciler] periodic stranded-sibling compensator tick error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Run the silently-merged compensator (`reconcileSilentlyMergedWorkspaces`) once.
 *
 * #380: this is Path A of the interrupted-merge pair — `mergedAt` was stamped by
 * `stampMergedAtEarly` but the `finalizeMergeCleanup` that follows it never ran, so the
 * workspace stays un-closed and the ISSUE stays in whatever status it was in (typically
 * In Review). Path B (`reconcileAncestorBranchWorkspaces`, above) has run on a periodic
 * cadence since it was written; Path A was wired ONLY into startup
 * (`startup-tasks.ts`), so a merge interrupted between those two writes could only be
 * recovered by a server RESTART.
 *
 * MEASURED consequence that motivated this (linklocker project, issue #12, 2026-08-10):
 * the merge landed at 01:31:15 with `mergedAt` stamped, the issue stayed In Review, and
 * nothing converged it until the next boot closed the workspace at 01:34:45 — 3.5 minutes
 * in which the pm-pipeline planner counted the ticket as open (`openTickets: 1`), refused
 * to plan the next round, and the client suppressed the live `step-9:v2` approval-gate
 * card. The only visible symptom was a stale "Round in progress — 1 ticket(s) still open".
 * Nothing tells the operator a restart is the cure, and
 * `openWorkspaceBlockMessage` (`terminal-move-guard.ts`) actively promises the opposite:
 * "merging auto-transitions the issue to Done".
 *
 * Shared onto this reconciler's cadence for the same reason #151 moved the stranded-sibling
 * compensator here: a bookkeeping step no operator was told to perform must self-heal within
 * one tick, not at the next boot. It lives in its own module rather than in `startup-tasks`
 * because importing it from there would close a dependency cycle (`startup-tasks` already
 * imports {@link reconcileAncestorBranchWorkspaces}) that `pnpm lint:arch` rejects — and a
 * dynamic `import()` does not evade that check, dependency-cruiser counts it too.
 *
 * `reconcileSilentlyMergedWorkspaces` is idempotent by construction — it selects only
 * `mergedAt IS NOT NULL AND status != 'closed'`, and `reconcileMergedIssue` no-ops once the
 * issue already sits on the target status — so running it every tick forever is safe.
 */
export async function runSilentlyMergedCompensatorTick(database?: Database): Promise<void> {
  try {
    await reconcileSilentlyMergedWorkspaces(database);
  } catch (err) {
    console.warn("[ancestor-reconciler] periodic silently-merged compensator tick error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Schedule the ancestor-branch reconciler to run shortly after boot and then periodically.
 * The stranded-sibling compensator (see {@link runStrandedSiblingCompensatorTick}) and the
 * silently-merged compensator (see {@link runSilentlyMergedCompensatorTick}, #380) run on
 * the SAME tick/cadence (#151) rather than only at startup.
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
    void runStrandedSiblingCompensatorTick(deps.database);
    // #380: Path A of the interrupted-merge pair. Deliberately NOT gated on
    // `reconciler_ancestor_branch_enabled` inside this closure — the enabled check lives in
    // `reconcileAncestorBranchWorkspaces` (Path B, git-touching and therefore expensive).
    // Path A is a pure DB sweep over `mergedAt IS NOT NULL AND status != 'closed'`, which is
    // cheap and must not be disable-able by a pref about git budget, exactly as the
    // stranded-sibling compensator above is not.
    void runSilentlyMergedCompensatorTick(deps.database);
  });
  const timer = setTimeout(tick, 35_000);
  const interval = setInterval(tick, intervalMs);
  activeAncestorTimeout = timer;
  activeAncestorInterval = interval;
  (timer).unref?.();
  (interval).unref?.();
  return { timer, interval };
}
