import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import {
  checkBranchTipIsAncestor,
  countUniqueCommits,
  detectConflictsByBranch,
  countBehindCommits,
  mergeBranch,
} from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { recordDriveObstacle } from "../services/drive-obstacles.service.js";
import { PREF_DONE_UNMERGED_SCANNER_ENABLED } from "../constants/preference-keys.js";

/** Issue status names that count as "terminal Done" — these are the ones we scan. */
const DONE_STATUS_NAMES = ["Done", "AI Reviewed"];

/** Max commits behind base for auto-merge to proceed. Branches further behind are left log-only. */
const MAX_BEHIND_FOR_AUTO_MERGE = 20;

/** Max auto-merge attempts per scanner cycle to limit blast radius. */
const MAX_AUTO_MERGES_PER_CYCLE = 3;

/**
 * If a branch is more than this many commits behind its base it is an ancient abandoned
 * workspace (observed: 60-658 behind in the #590 mass-reopen incident) — NOT a
 * recoverable silent-merge-loss candidate; skip it.
 */
const MAX_COMMITS_BEHIND_BASE = 20;

export interface DoneUnmergedScannerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
  /** Injectable for testing. Defaults to the real countUniqueCommits from git-service. */
  countCommits?: typeof countUniqueCommits;
  /** Injectable for testing. Defaults to the real detectConflictsByBranch from git-service. */
  detectConflicts?: typeof detectConflictsByBranch;
  /** Injectable for testing. Defaults to the real countBehindCommits from git-service. */
  countBehind?: typeof countBehindCommits;
  /** Injectable for testing. Defaults to the real mergeBranch from git-service. */
  mergeGitBranch?: typeof mergeBranch;
  /**
   * Override enabled state for testing. When undefined (production path), the scanner
   * reads the live preference from the DB at call time.
   */
  enabled?: boolean;
  /**
   * Override the staleness threshold for testing. Defaults to MAX_COMMITS_BEHIND_BASE (20).
   * Branches more than this many commits behind base are ancient abandoned workspaces —
   * not recoverable silent-merge-loss.
   */
  maxCommitsBehindBase?: number;
  /**
   * Override the timer callback for testing. When provided, replaces the default tick
   * (which calls scanDoneUnmergedWorkspaces) so tests can verify the interval stops
   * firing without needing a real DB or git setup.
   */
  onTick?: () => void;
}

export interface DoneUnmergedFinding {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  projectId: string;
  branch: string;
  baseBranch: string;
  branchSha: string;
  baseSha: string;
  uniqueCommitCount: number;
  statusName: string;
}

export interface DoneUnmergedScanResult {
  findings: DoneUnmergedFinding[];
  /** @deprecated reopenToInReview was removed; this is always 0 */
  reopened: number;
  autoMerged: number;
}

/** Resolve the scanner's injectable git/db dependencies, defaulting each to the real implementation. */
function resolveScanDeps(deps: DoneUnmergedScannerDeps) {
  return {
    database: deps.database ?? db,
    ancestorCheck: deps.checkAncestor ?? checkBranchTipIsAncestor,
    commitCounter: deps.countCommits ?? countUniqueCommits,
    conflictDetector: deps.detectConflicts ?? detectConflictsByBranch,
    behindCounter: deps.countBehind ?? countBehindCommits,
    gitMerge: deps.mergeGitBranch ?? mergeBranch,
    maxBehind: deps.maxCommitsBehindBase ?? MAX_COMMITS_BEHIND_BASE,
  };
}

/**
 * Startup invariant scanner that detects Done-but-unmerged issues (silent-merge-loss)
 * and performs SAFE forward-only auto-recovery: merges clean ahead-only branches into base,
 * leaving the issue Done.
 *
 * Safety invariants:
 * - NEVER reopens an issue (no statusId change).
 * - NEVER touches a 0-commit branch (ahead==0) — those are the false-positive class.
 * - Only auto-merges when: ahead>=1, behind<=MAX_BEHIND_FOR_AUTO_MERGE, no conflicts.
 * - Conflicted / behind-too-far / 0-ahead candidates are logged only.
 * - Rate-limited: at most MAX_AUTO_MERGES_PER_CYCLE attempts per scan cycle.
 * - Idempotent: mergedAt stamp prevents re-processing on subsequent scans.
 */
export async function scanDoneUnmergedWorkspaces(
  deps: DoneUnmergedScannerDeps & { reopenToInReview?: boolean } = {},
): Promise<DoneUnmergedScanResult> {
  const { database, ancestorCheck, commitCounter, conflictDetector, behindCounter, gitMerge, maxBehind } =
    resolveScanDeps(deps);

  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : await (async () => {
        try {
          const row = await database.select({ value: preferences.value }).from(preferences)
            .where(eq(preferences.key, PREF_DONE_UNMERGED_SCANNER_ENABLED)).limit(1);
          return row.length === 0 || row[0].value !== "false";
        } catch {
          return true;
        }
      })();

  if (!isEnabled) {
    console.log("[done-unmerged-scanner] disabled via preference — skipping scan");
    return { findings: [], reopened: 0, autoMerged: 0 };
  }

  // Find non-direct workspaces whose issue IS in a terminal Done status
  // and whose branch was NOT recorded as merged (mergedAt IS NULL).
  const candidates = await database
    .select({
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      workingDir: workspaces.workingDir,
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
        eq(workspaces.isDirect, false),
        isNull(workspaces.mergedAt),
        inArray(projectStatuses.name, DONE_STATUS_NAMES),
      ),
    );

  if (candidates.length === 0) return { findings: [], reopened: 0, autoMerged: 0 };

  // Guard #1 (false-positive fix #590): collect issue IDs that have ANY merged workspace.
  // An issue whose workspace A was genuinely merged (mergedAt set) must not be flagged
  // just because a stale workspace B (mergedAt null) also exists on it.
  const candidateIssueIds = [...new Set(candidates.map(c => c.issueId))];
  const mergedRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(and(inArray(workspaces.issueId, candidateIssueIds), isNotNull(workspaces.mergedAt)));
  const issuesWithAMergedWorkspace = new Set(mergedRows.map(r => r.issueId));

  const findings: DoneUnmergedFinding[] = [];
  let autoMerged = 0;
  const now = new Date().toISOString();
  // Track which workspaces have already been attempted this cycle (idempotency guard).
  const attemptedWorkspaceIds = new Set<string>();

  /** One row of the candidate query above (a non-direct, unmerged workspace on a Done issue). */
  type DoneUnmergedCandidate = (typeof candidates)[number];

  // Flag phase: decide whether one candidate is a Done-but-unmerged finding (or null to
  // skip), recording the violation telemetry. Closes over the injected git fns + maxBehind
  // + issuesWithAMergedWorkspace + the findings accumulator; runs the gated git I/O in order.
  async function evaluateCandidateForFinding(c: DoneUnmergedCandidate): Promise<DoneUnmergedFinding | null> {
    if (!c.branch || !c.baseBranch || !c.repoPath) return null;

    // Guard #1: issue already has a genuinely-merged workspace — not a silent-merge-loss.
    if (issuesWithAMergedWorkspace.has(c.issueId)) {
      console.log(`[done-unmerged-scanner] skipping issue #${c.issueNumber ?? "?"} — has a merged workspace (not a silent-merge-loss)`);
      return null;
    }

    let result: Awaited<ReturnType<typeof checkBranchTipIsAncestor>>;
    try {
      result = await ancestorCheck(c.repoPath, c.branch, c.baseBranch, c.workingDir ?? undefined);
    } catch (err) {
      console.warn(`[done-unmerged-scanner] git ancestry check failed for workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      return null;
    }

    // If the branch IS already an ancestor of base, the work landed — skip.
    if (result.isAncestor) return null;

    // Branch is not reachable from base — check how many unique commits it has.
    if (!result.branchSha) return null;

    // Guard #2: staleness check — count how many commits base has that the branch does NOT.
    // A branch 60-658 commits behind is an ancient abandoned workspace (#590 incident), not
    // a recoverable silent-merge-loss. Skip it to avoid false positives.
    let commitsBehind: number;
    try {
      commitsBehind = await commitCounter(c.repoPath, result.branchSha, result.baseSha);
    } catch {
      commitsBehind = 0;
    }
    if (commitsBehind > maxBehind) {
      console.log(`[done-unmerged-scanner] skipping issue #${c.issueNumber ?? "?"} workspace ${c.wsId} — branch is ${commitsBehind} commits behind ${c.baseBranch} (staleness threshold: ${maxBehind})`);
      return null;
    }

    let uniqueCommits: number;
    try {
      uniqueCommits = await commitCounter(c.repoPath, result.baseSha, result.branchSha);
    } catch {
      uniqueCommits = 0;
    }

    // Only flag if there is at least 1 unique commit (0-commit branches have no real work).
    if (uniqueCommits === 0) return null;

    const finding: DoneUnmergedFinding = {
      workspaceId: c.wsId,
      issueId: c.issueId,
      issueNumber: c.issueNumber,
      projectId: c.projectId,
      branch: c.branch,
      baseBranch: c.baseBranch,
      branchSha: result.branchSha,
      baseSha: result.baseSha,
      uniqueCommitCount: uniqueCommits,
      statusName: c.statusName,
    };
    findings.push(finding);

    console.warn(
      `[done-unmerged-scanner] INVARIANT VIOLATION: issue #${c.issueNumber ?? "?"} is '${c.statusName}' but branch '${c.branch}' has ${uniqueCommits} commit(s) NOT reachable from ${c.baseBranch} (branchSha=${result.branchSha}, baseSha=${result.baseSha}) — silent merge loss detected`,
    );

    try {
      await logBoardHealthEvent({
        projectId: c.projectId,
        cycleId: `done-unmerged-scan-${c.wsId}`,
        eventType: "observation",
        category: "merge",
        issueNumber: c.issueNumber ?? undefined,
        summary: `Done-but-unmerged invariant violation: issue #${c.issueNumber ?? "?"} is '${c.statusName}' but branch '${c.branch}' has ${uniqueCommits} unmerged commit(s) not reachable from ${c.baseBranch}.`,
        details: { workspaceId: c.wsId, branchSha: result.branchSha, baseSha: result.baseSha, uniqueCommitCount: uniqueCommits, detectedAt: now },
      }, database);
    } catch { /* health event logging is non-fatal */ }

    // Structured drive-obstacle telemetry (#803): emit a typed silent_merge_loss event so
    // this friction is queryable + dashboard-feedable, not just in the free-text health log.
    // recordDriveObstacle is non-throwing, so no try/catch needed.
    await recordDriveObstacle({
      projectId: c.projectId,
      kind: "silent_merge_loss",
      severity: "critical",
      issueNumber: c.issueNumber ?? null,
      summary: `Silent merge loss: issue #${c.issueNumber ?? "?"} is '${c.statusName}' but branch '${c.branch}' has ${uniqueCommits} unmerged commit(s) not on ${c.baseBranch}.`,
      details: { workspaceId: c.wsId, branch: c.branch, baseBranch: c.baseBranch, branchSha: result.branchSha, baseSha: result.baseSha, uniqueCommitCount: uniqueCommits },
    }, { database });
    return finding;
  }

  // Auto-recovery phase: safe forward-only auto-merge of a flagged finding. Closes over the
  // injected git fns + database + now, and mutates the cycle counters (autoMerged /
  // attemptedWorkspaceIds). Same gated I/O order + rate-limit/behind/conflict guards as before.
  async function attemptForwardOnlyAutoMerge(c: DoneUnmergedCandidate, finding: DoneUnmergedFinding): Promise<void> {
    // Required fields are guaranteed present here (a finding only exists past
    // evaluateCandidateForFinding's field guard); re-narrow them for the git calls below
    // now that this is a separate function scope — the original relied on the loop-level guard.
    if (!c.branch || !c.baseBranch || !c.repoPath) return;
    // --- SAFE FORWARD-ONLY AUTO-RECOVERY ---
    // Skip if rate limit reached or already attempted this cycle.
    if (autoMerged >= MAX_AUTO_MERGES_PER_CYCLE || attemptedWorkspaceIds.has(c.wsId)) {
      if (autoMerged >= MAX_AUTO_MERGES_PER_CYCLE) {
        console.log(`[done-unmerged-scanner] auto-merge cap (${MAX_AUTO_MERGES_PER_CYCLE}/cycle) reached — leaving workspace ${c.wsId} log-only this cycle`);
      }
      return;
    }

    // Check how far behind base the branch is.
    let behind: number;
    try {
      behind = await behindCounter(c.repoPath, c.branch, c.baseBranch);
    } catch {
      behind = MAX_BEHIND_FOR_AUTO_MERGE + 1; // treat error as too-far-behind
    }

    if (behind > MAX_BEHIND_FOR_AUTO_MERGE) {
      console.warn(
        `[done-unmerged-scanner] issue #${c.issueNumber ?? "?"} branch '${c.branch}' is ${behind} commit(s) behind ${c.baseBranch} (limit ${MAX_BEHIND_FOR_AUTO_MERGE}) — leaving log-only`,
      );
      return;
    }

    // Read-only conflict check using the branch names directly from the repo.
    let hasConflicts: boolean;
    try {
      const conflictResult = await conflictDetector(c.repoPath, c.branch, c.baseBranch);
      hasConflicts = conflictResult.hasConflicts;
      if (hasConflicts) {
        console.warn(
          `[done-unmerged-scanner] issue #${c.issueNumber ?? "?"} branch '${c.branch}' has merge conflicts with ${c.baseBranch} — leaving log-only`,
        );
        return;
      }
    } catch (err) {
      console.warn(`[done-unmerged-scanner] conflict check failed for workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      return;
    }

    // All guards passed: ahead>=1, behind<=limit, no conflicts — attempt auto-merge.
    attemptedWorkspaceIds.add(c.wsId);
    try {
      console.log(
        `[done-unmerged-scanner] auto-merging: issue #${c.issueNumber ?? "?"} branch '${c.branch}' → ${c.baseBranch} (ahead=${finding.uniqueCommitCount}, behind=${behind})`,
      );
      await gitMerge(c.repoPath, c.branch, c.baseBranch);

      // Stamp mergedAt and close the workspace. Issue stays Done — no status change.
      await database
        .update(workspaces)
        .set({ mergedAt: now, status: "closed", closedAt: now, updatedAt: now })
        .where(eq(workspaces.id, c.wsId));

      autoMerged++;
      console.log(
        `[done-unmerged-scanner] auto-merged issue #${c.issueNumber ?? "?"} — branch '${c.branch}' is now on ${c.baseBranch}; issue remains Done`,
      );

      try {
        await logBoardHealthEvent({
          projectId: c.projectId,
          cycleId: `done-unmerged-automerge-${c.wsId}`,
          eventType: "action",
          category: "merge",
          issueNumber: c.issueNumber ?? undefined,
          summary: `Done-but-unmerged auto-recovery: merged branch '${c.branch}' into ${c.baseBranch}. Issue #${c.issueNumber ?? "?"} remains Done.`,
          details: { workspaceId: c.wsId, branchSha: finding.branchSha, baseSha: finding.baseSha, uniqueCommitCount: finding.uniqueCommitCount, behind, autoMergedAt: now },
        }, database);
      } catch { /* health event logging is non-fatal */ }
    } catch (err) {
      console.warn(
        `[done-unmerged-scanner] auto-merge failed for workspace ${c.wsId} (issue #${c.issueNumber ?? "?"}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  for (const c of candidates) {
    const finding = await evaluateCandidateForFinding(c);
    if (!finding) continue;
    await attemptForwardOnlyAutoMerge(c, finding);
  }

  if (findings.length > 0) {
    console.warn(`[done-unmerged-scanner] found ${findings.length} Done-but-unmerged issue(s); auto-merged ${autoMerged}`);
  }

  return { findings, reopened: 0, autoMerged };
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Module-level singleton handles — cleared on each startDoneUnmergedScanner call so
// tsx hot-reload never accumulates duplicate intervals (cycle-39 reaper incident).
let _activeTimer: NodeJS.Timeout | null = null;
let _activeInterval: NodeJS.Timeout | null = null;

export function stopDoneUnmergedScanner(): void {
  if (_activeTimer !== null) {
    clearTimeout(_activeTimer);
    _activeTimer = null;
  }
  if (_activeInterval !== null) {
    clearInterval(_activeInterval);
    _activeInterval = null;
  }
}

/**
 * Schedule the done-unmerged invariant scanner to run shortly after boot and then periodically.
 *
 * Hot-reload-safe: clears any previously registered timer/interval before installing new ones
 * so tsx hot-reload never accumulates duplicate ticks. Both handles are unref'd so they don't
 * prevent the process from exiting cleanly.
 */
export function startDoneUnmergedScanner(
  deps: Omit<DoneUnmergedScannerDeps, "enabled"> = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): { timer: NodeJS.Timeout; interval: NodeJS.Timeout } {
  // Clear any prior handles from a previous hot-reload cycle.
  stopDoneUnmergedScanner();

  const tick = deps.onTick ?? (() => {
    scanDoneUnmergedWorkspaces(deps).catch((err) =>
      console.warn("[done-unmerged-scanner] periodic tick error:", err instanceof Error ? err.message : err),
    );
  });
  const timer = setTimeout(tick, 40_000);
  const interval = setInterval(tick, intervalMs);
  (timer).unref?.();
  (interval).unref?.();
  _activeTimer = timer;
  _activeInterval = interval;
  return { timer, interval };
}

/**
 * Run the done-unmerged invariant scan immediately (fire-and-forget).
 * Called after a merge completes to catch silent-merge-loss without waiting for the next interval.
 */
export function runDoneUnmergedScannerNow(
  deps: Omit<DoneUnmergedScannerDeps, "enabled"> = {},
): void {
  scanDoneUnmergedWorkspaces(deps).catch((err) =>
    console.warn("[done-unmerged-scanner] post-merge scan error:", err instanceof Error ? err.message : err),
  );
}
