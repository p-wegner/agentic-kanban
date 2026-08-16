import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { sessions } from "@agentic-kanban/shared/schema";
import { desc, eq, sql, or, isNull, notInArray, and } from "drizzle-orm";
import { db } from "../db/index.js";
import type { createBoardEvents } from "../services/board-events.js";
import { sendMonitorNudge, type MonitorActionName } from "../services/monitor-nudge.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import type { createSessionManager } from "../services/session.manager.js";
import type { MonitorAction } from "./monitor-helpers.js";
import { NOISE_TRIGGER_TYPES } from "../services/session-filter.js";
import { commitLeftoverChanges, countBehindCommits, getCommitCountAhead, getWorkingTreeDiff } from "../services/git.service.js";
import { startManualReview } from "../services/review.service.js";
import { isCodexUsageLimitStats } from "../services/codex-rate-limit.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getStackProfile, verifyScriptPrefKey } from "../services/stack-profile.service.js";
import { runPreMergeGate, resolveMergeGateShas, gateAlreadyPassed, RUN_GATE, type MergeGateToken, type MergeGateEvidence } from "../services/pre-merge-gate.service.js";
import {
  MAX_SESSIONS,
  NON_TRIVIAL_WORKTREE_DIFF_CHARS,
  classifyQuotaBlock,
  hasRepeatedFailedCommand,
  isBuilderSession,
  isZeroDiffInReviewAwaiting,
  orderCandidatesForWalk,
  parseStuckBuilderTimeoutMs,
  type LatestSession,
} from "./monitor-cycle-rules.js";
import {
  closeDirectWorkspaceAsDone,
  getProjectStatusIdByName,
  mergeWorkspaceWithFixFallback,
  type LogMonitorActionFn,
} from "./monitor-cycle-actions.js";
import type { MonitorWorkspaceActions } from "./monitor-workspace-actions.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { shouldSkipMergeForBackoff, type MergeBackoffDeps } from "../services/merge-backoff.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export { DEFAULT_STUCK_BUILDER_TIMEOUT_MS } from "./monitor-cycle-rules.js";

export const MAX_MONITOR_RELAUNCHES_PER_CYCLE = 2;
export const MAX_MONITOR_MERGES_PER_CYCLE = 2;
/**
 * Per-project ceiling on how long a single project's candidate walk may run within
 * one cycle before its REMAINING candidates are deferred to the next cycle (#208).
 * Protects the shared cycle from one slow/unhealthy project (repeated failing verify
 * gates, missing worktrees, etc.) starving every other project's auto-start/auto-merge
 * pass — previously a single sequential walk with no per-project ceiling.
 */
export const DEFAULT_MONITOR_PROJECT_TIME_BUDGET_MS = 30_000;
/**
 * Wall-clock ceiling on a SINGLE candidate's processing, after which the walk stops
 * waiting for it (the abandoned work keeps running detached, but no longer holds the
 * cycle). #208 only bounded the walk BETWEEN candidates: the project deadline was
 * checked before each candidate and never again, so one candidate awaiting an
 * unbounded `git` call (credential prompt, dead network mount, a Windows git that
 * never exits) made `processWorkspaceCandidates` never resolve. The cycle's `finally`
 * then never ran, `cycleRunning` stayed `true` forever, and EVERY later cycle
 * short-circuited on the re-entrancy guard — for every project, until a restart.
 * A between-candidates deadline cannot express that; preemption has to be a race.
 *
 * Deliberately independent of `projectTimeBudgetMs` (and generous): the project budget
 * is a scheduling fairness knob measured on an INJECTED clock, while this is a real
 * wall-clock hang detector. Coupling them would make a small test/ops budget abandon
 * healthy candidates mid-merge.
 */
export const DEFAULT_MONITOR_CANDIDATE_TIMEOUT_MS = 5 * 60_000;
/** Bounded concurrency across DIFFERENT projects' candidate walks — the pass is I/O
 *  and subprocess bound, so unrelated projects need not wait on each other (#208). */
export const DEFAULT_MONITOR_PROJECT_CONCURRENCY = 4;

export interface WorkspaceCandidate {
  wsId: string;
  wsStatus: string;
  workingDir: string | null;
  isDirect: boolean;
  projectId: string;
  issueId: string;
  issueTitle: string;
  issueNumber: number | null;
  issueStatusName: string;
  baseBranch: string | null;
  readyForMerge: boolean;
  diffStatCacheFilesChanged?: number | null;
  diffStatCacheInsertions?: number | null;
  diffStatCacheDeletions?: number | null;
  /** Real evidence of when/how the pre-merge gate last ACTUALLY ran and passed (persisted by
   *  exit-workflow at review-exit alongside `readyForMerge`). Null when `readyForMerge` was set
   *  with no gate run (e.g. manual ready-for-merge) — the monitor must then re-run the gate. */
  mergeGateRanAt?: string | null;
  mergeGateStage?: string | null;
  mergeGateBranchSha?: string | null;
  mergeGateBaseSha?: string | null;
  mergeGateSource?: string | null;
}

/**
 * Build the merge-gate DECISION token for a `readyForMerge` workspace from the REAL evidence
 * persisted when the gate last ran (exit-workflow, at review-exit) — NOT a freshly fabricated
 * `ranAt: new Date()` (#182), which would make `resolveMergeGate`'s 15-min staleness guard
 * unable to ever fire on this path. No persisted evidence (never gated, e.g. a manual
 * `POST /workspaces/:id/ready-for-merge`) forces a real gate run via `RUN_GATE`.
 */
function gateTokenFromWorkspaceEvidence(ws: WorkspaceCandidate, source: string): MergeGateToken {
  if (ws.mergeGateRanAt && ws.mergeGateStage) {
    // Carry the recorded tips (0108) so `resolveMergeGate` can validate the pass by CONTENT.
    // Without them a pass that is merely old is re-gated (a wasted full suite + build) and a
    // pass whose base has since moved is trusted purely because it looks recent.
    return gateAlreadyPassed({
      ranAt: ws.mergeGateRanAt,
      stage: ws.mergeGateStage as MergeGateEvidence["stage"],
      source,
      branchSha: ws.mergeGateBranchSha ?? undefined,
      baseSha: ws.mergeGateBaseSha ?? undefined,
    });
  }
  return RUN_GATE;
}

export interface ProcessWorkspaceDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  /**
   * Port for the workspace mutations the monitor drives (relaunch/merge/
   * fix-and-merge/delete). Injected so the monitor calls the application service
   * DIRECTLY instead of self-HTTP — see monitor-workspace-actions.ts. Replaced the
   * old `serverPort` + `fetch('http://127.0.0.1:<port>/...')` plumbing.
   */
  workspaceActions: MonitorWorkspaceActions;
  /**
   * Whether the monitor is allowed to auto-merge workspaces on its timer.
   * Gated on the `auto_merge` preference being exactly "true". When false/unset,
   * the monitor must NOT merge (leaving the workspace in its current state) so an
   * operator can freeze automatic merging. Does NOT affect the manual
   * `POST /api/workspaces/:id/merge` route, relaunch, auto-start, or nudge behavior.
   */
  autoMergeEnabled: boolean;
  /**
   * Set of project IDs for which auto-merge is disabled via the per-project
   * `auto_merge_disabled_<projectId>` preference. Workspaces belonging to these
   * projects are skipped even when the global `autoMergeEnabled` flag is true.
   */
  autoMergeDisabledProjectIds?: Set<string>;
  /**
   * Whether the monitor may auto-merge In Review workspaces that are NOT marked
   * `readyForMerge`. Gated on the `auto_merge_in_review` preference being exactly
   * "true" (default off). When off, an idle In-Review workspace whose work is
   * committed but not explicitly marked ready is left untouched (the agent/human
   * `readyForMerge` handshake is respected). When on, the monitor merges it anyway
   * — "land In Review work without the readyForMerge gate". Still also requires
   * `autoMergeEnabled` (the operator kill-switch).
   */
  autoMergeInReview: boolean;
  reviewSessionIds: Set<string>;
  monitorRecentActions: MonitorAction[];
  logMonitorAction: (recentActions: MonitorAction[], action: MonitorActionName, workspaceId: string, issueId: string, extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">) => void;
  buildMonitorNudgePrompt: (projectId: string) => Promise<string>;
  getRecentAgentExcerpts: (sessionId: string, count?: number) => Promise<string[]>;
  shouldSkipNudge: (excerpts: string[]) => boolean;
  maxRelaunchesPerCycle?: number;
  maxMergesPerCycle?: number;
  stuckBuilderTimeoutMs?: number;
  getCommitCountAhead?: typeof getCommitCountAhead;
  countBehindCommits?: typeof countBehindCommits;
  getWorkingTreeDiff?: typeof getWorkingTreeDiff;
  commitLeftoverChanges?: typeof commitLeftoverChanges;
  startReview?: typeof startManualReview;
  /** Per-project time budget (ms) — see `DEFAULT_MONITOR_PROJECT_TIME_BUDGET_MS`. */
  projectTimeBudgetMs?: number;
  /** Max number of DIFFERENT projects' candidate walks processed concurrently. */
  projectConcurrency?: number;
  /** Real wall-clock cap per candidate — see `DEFAULT_MONITOR_CANDIDATE_TIMEOUT_MS`. */
  candidateTimeoutMs?: number;
  /**
   * #416: absolute deadline (on the injected `now` clock) after which NO NEW project
   * sub-pass may start. Projects whose walk never started are reported in
   * `notStartedProjectIds` so the cross-cycle scheduler's carry-over cursor resumes at
   * the first of them next cycle. A walk already in flight when the deadline passes is
   * still bounded only by its own per-project budget — this gate stops NEW groups, it
   * never truncates a started one (per-project semantics stay identical).
   */
  cycleDeadlineMs?: number;
  /** Clock seam for deterministic time-budget tests. */
  now?: () => number;
  /** Seams for the #417 merge-retry backoff (test database/clock/probes). */
  mergeBackoff?: MergeBackoffDeps;
}

export interface ProcessWorkspaceCandidatesResult {
  relaunched: number;
  merged: number;
  nudged: number;
  /** Projects whose candidate walk exceeded its time budget this cycle — their
   *  remaining candidates were skipped and will be picked up next cycle. */
  deferredProjectIds: string[];
  /** #416: projects whose candidate walk ran to COMPLETION this cycle (neither deferred
   *  mid-walk nor stopped before starting) — the scheduler stamps their sub-pass clock. */
  completedProjectIds: string[];
  /** #416: projects whose sub-pass never STARTED because the global cycle deadline
   *  (`cycleDeadlineMs`) had passed — the carry-over cursor resumes at the first of these. */
  notStartedProjectIds: string[];
}

/** Shared per-cycle state handed to the per-status handlers. `stats` is the
 * SAME mutable object the cap closures read, so cap-check-before-action math
 * is unchanged by the decomposition. */
type CycleContext = {
  deps: ProcessWorkspaceDeps;
  stats: { relaunched: number; merged: number; nudged: number };
  logAction: LogMonitorActionFn;
  canStartRelaunch: (ws: WorkspaceCandidate) => boolean;
  canStartMerge: (ws: WorkspaceCandidate) => boolean;
  stuckBuilderTimeoutMs: number;
};

/**
 * Whether a project has an automatic pre-merge quality gate — a `verify_script` (build/test) and/or
 * a web smoke check (isWeb stack profile → boot + render check). The verify+smoke gate runs when a
 * review session EXITS (exit-workflow) and sets `readyForMerge` only on pass. So for a gated
 * project the monitor must NOT bypass `readyForMerge` via auto_merge_in_review — doing so races the
 * in-flight review and merges the work before (or instead of) the gate, which then sees the work
 * "already merged" and is skipped entirely. The fix: for gated projects, only auto-merge work the
 * gate has approved (readyForMerge=true); un-ready In-Review work waits for the review's gate.
 */
export async function projectHasMergeGate(projectId: string, database = db): Promise<boolean> {
  try {
    const verify = await getPreference(verifyScriptPrefKey(projectId), database);
    if (verify && verify.trim()) return true;
    const profile = await getStackProfile(projectId, database);
    return profile?.isWeb === true;
  } catch {
    return false; // best-effort: never block the monitor on a gate-detection error
  }
}

async function recoverStuckBuilder(
  ws: WorkspaceCandidate,
  sess: LatestSession,
  deps: ProcessWorkspaceDeps,
  logAction: LogMonitorActionFn,
): Promise<boolean> {
  if (ws.isDirect || !ws.workingDir || !ws.baseBranch || !isBuilderSession(sess)) return false;

  const ahead = await (deps.getCommitCountAhead ?? getCommitCountAhead)(ws.workingDir, ws.baseBranch).catch(() => -1);
  if (ahead !== 0) return false;

  const diff = await (deps.getWorkingTreeDiff ?? getWorkingTreeDiff)(ws.workingDir).catch(() => "");
  const hasNonTrivialDiff = diff.trim().length >= NON_TRIVIAL_WORKTREE_DIFF_CHARS;
  const retryLoop = hasRepeatedFailedCommand(sess.stats);
  if (!hasNonTrivialDiff && !retryLoop) return false;

  console.log(`[monitor] Recovering stuck builder workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} (diff=${hasNonTrivialDiff}, retryLoop=${retryLoop})`);
  await deps.sessionManager.stopSession(sess.id);
  await db.update(sessions).set({ status: "stopped", endedAt: new Date().toISOString() }).where(eq(sessions.id, sess.id)).catch(() => {});

  const committedFiles = await (deps.commitLeftoverChanges ?? commitLeftoverChanges)(ws.workingDir);
  await setWorkspaceStatus(db, ws.wsId, "idle");

  if (committedFiles <= 0) {
    logAction("mark_idle", ws.wsId, ws.issueId, {
      responseSummary: "Stopped stuck builder, but no leftover files could be committed",
      verificationResult: "failed",
    });
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    console.warn(`[monitor] Stuck builder recovery for workspace ${ws.wsId} stopped the session but did not create a commit`);
    return true;
  }

  const inReviewStatusId = await getProjectStatusIdByName(ws.projectId, "In Review");
  if (inReviewStatusId) {
    await transitionIssueStatus(db, ws.issueId, inReviewStatusId);
  }

  const { sessionId } = await (deps.startReview ?? startManualReview)(db, () => deps.sessionManager, deps.boardEvents, deps.reviewSessionIds, ws.wsId, false);
  logAction("mark_idle", ws.wsId, ws.issueId, {
    responseSummary: `Recovered stuck builder: committed ${committedFiles} leftover file(s), review session ${sessionId}`,
    verificationResult: "ok",
  });
  emitButlerSystemEvent({
    projectId: ws.projectId,
    kind: "stuck_agent",
    workspaceId: ws.wsId,
    issueNumber: ws.issueNumber ?? undefined,
    text: `Recovered stuck builder for issue #${ws.issueNumber ?? "?"}: stopped session ${sess.id}, committed ${committedFiles} leftover file(s), and launched review ${sessionId}.`,
  });
  deps.boardEvents.broadcast(ws.projectId, "board_changed");
  return true;
}

/**
 * #191: an idle, non-`readyForMerge` builder can hold a COMPLETE, committed implementation
 * whose base branch simply moved out from under it (a sibling ticket merged after this
 * branch was cut). Left alone it is silently indistinguishable from an idle-empty
 * workspace — the catch-all relaunch just re-runs an agent that has nothing left to do.
 * Detects that specific shape: real commits ahead of base (`ahead > 0`) AND base has moved
 * (`behind > 0`, i.e. base is NOT an ancestor of this worktree's HEAD). Best-effort: any git
 * failure (missing worktree, non-repo path in tests) is treated as "not stale" so callers
 * fall through to the existing behavior unchanged.
 */
async function hasStaleBaseWithCommits(ws: WorkspaceCandidate, deps: ProcessWorkspaceDeps): Promise<boolean> {
  if (ws.isDirect || !ws.workingDir || !ws.baseBranch) return false;
  const ahead = await (deps.getCommitCountAhead ?? getCommitCountAhead)(ws.workingDir, ws.baseBranch).catch(() => null);
  if (!ahead || ahead <= 0) return false;
  const behind = await (deps.countBehindCommits ?? countBehindCommits)(ws.workingDir, "HEAD", ws.baseBranch).catch(() => 0);
  return behind > 0;
}

/**
 * #324 — the sibling shape: NO commits ahead, but the base moved (`behind > 0`).
 * A blocked builder (e.g. a loop step agent that halted on a missing input file)
 * left the worktree empty; meanwhile the missing input landed on the base branch.
 * A bare relaunch re-runs the agent against the SAME stale tree and fails
 * identically, burning a session per monitor cycle. Rebasing first (a no-op
 * fast-forward — there are no local commits) gives the relaunched agent the
 * current base. Best-effort like its sibling: git failures mean "not this shape".
 */
async function hasMovedBaseNoCommits(ws: WorkspaceCandidate, deps: ProcessWorkspaceDeps): Promise<boolean> {
  if (ws.isDirect || !ws.workingDir || !ws.baseBranch) return false;
  const ahead = await (deps.getCommitCountAhead ?? getCommitCountAhead)(ws.workingDir, ws.baseBranch).catch(() => null);
  if (ahead == null || ahead > 0) return false;
  const behind = await (deps.countBehindCommits ?? countBehindCommits)(ws.workingDir, "HEAD", ws.baseBranch).catch(() => 0);
  return behind > 0;
}

/** Build the #417 backoff deps from the cycle deps: injected seams win; the monitor's
 *  clock seam and board broadcaster are threaded through so tests stay deterministic
 *  and the drive-obstacle warning reaches live clients. */
function mergeBackoffDeps(deps: ProcessWorkspaceDeps): MergeBackoffDeps {
  return {
    now: deps.now ? () => new Date(deps.now!()) : undefined,
    broadcast: (projectId, reason) => deps.boardEvents.broadcast(projectId, reason),
    ...deps.mergeBackoff,
  };
}

/**
 * #417 circuit breaker: when this workspace's previous merge/fix-and-merge attempt failed
 * and the IDENTICAL failure is still inside its (exponentially growing) backoff window,
 * skip the attempt entirely — BEFORE the per-cycle merge slot is consumed and before any
 * expensive gate/verify work. A relevant state change (new commit, main checkout clean,
 * verify script changed) clears the block inside `shouldSkipMergeForBackoff` itself.
 */
async function mergeBlockedByBackoff(ws: WorkspaceCandidate, deps: ProcessWorkspaceDeps): Promise<boolean> {
  const decision = await shouldSkipMergeForBackoff(
    { wsId: ws.wsId, projectId: ws.projectId, workingDir: ws.workingDir, issueNumber: ws.issueNumber },
    mergeBackoffDeps(deps),
  ).catch(() => ({ skip: false as const, reason: undefined }));
  if (decision.skip) {
    console.log(`[monitor] Skipping merge for workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}) — ${decision.reason}`);
    return true;
  }
  return false;
}

async function handleIdleWorkspace(ws: WorkspaceCandidate, sess: LatestSession | undefined, sessionCount: number, ctx: CycleContext): Promise<void> {
  const { deps, stats, logAction, canStartRelaunch, canStartMerge } = ctx;
  if (isCodexUsageLimitStats(sess?.stats)) {
    await setWorkspaceStatus(db, ws.wsId, "blocked");
    console.log(`[monitor] Needs attention: workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} hit a Codex usage limit; skipping relaunch`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return;
  }
  if (isZeroDiffInReviewAwaiting(ws)) {
    console.log(`[monitor] Needs attention: idle-awaiting workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} is In Review with no file changes and is not ready for merge`);
    return;
  }
  if (ws.isDirect) {
    await closeDirectWorkspaceAsDone(ws, logAction);
    console.log(`[monitor] Closed stale direct workspace ${ws.wsId}  issue moved to Done`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (ws.readyForMerge) {
    if (!deps.autoMergeEnabled) {
      console.log(`[monitor] Skipping auto-merge for idle+readyForMerge workspace ${ws.wsId}  auto_merge is disabled`);
      return;
    }
    if (deps.autoMergeDisabledProjectIds?.has(ws.projectId)) {
      console.log(`[monitor] Skipping auto-merge for idle+readyForMerge workspace ${ws.wsId}  auto_merge_disabled for project ${ws.projectId}`);
      return;
    }
    if (await mergeBlockedByBackoff(ws, deps)) return;
    if (!canStartMerge(ws)) return;
    // readyForMerge is only set by the review-exit handler AFTER its verify/smoke gate passed,
    // so hand the merge that PROOF (arch-review §1.2) rather than a bare "trust me" — built from
    // the REAL ranAt/stage persisted at that gate run (#182), not a freshly fabricated timestamp
    // that could never go stale.
    await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
      conflictMsg: `[monitor] Merge conflict for idle+readyForMerge workspace ${ws.wsId}  triggered fix-and-merge`,
      successMsg: `[monitor] Triggered merge for idle+readyForMerge workspace ${ws.wsId}`,
    }, gateTokenFromWorkspaceEvidence(ws, "review-exit gate (readyForMerge, idle)"), mergeBackoffDeps(deps));
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (await hasStaleBaseWithCommits(ws, deps)) {
    // #191: finished-but-stuck — real committed work, blocked only by a stale base. Recover it
    // the same way a human would (update-base then land), rather than falling into the
    // catch-all relaunch (which just wakes an agent with nothing left to do) or the
    // stuck-session flag/close path (which would strand the finished work as "closed").
    if (!deps.autoMergeEnabled || deps.autoMergeDisabledProjectIds?.has(ws.projectId)) {
      logAction("mark_idle", ws.wsId, ws.issueId, {
        responseSummary: "Idle workspace has committed work but its base branch has moved (stale base); auto_merge is disabled so it was flagged instead of auto-recovered",
        verificationResult: "failed",
      });
      console.log(`[monitor] Needs attention: idle workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} has committed work on a stale base  auto_merge disabled, flagging instead of recovering`);
      emitButlerSystemEvent({
        projectId: ws.projectId,
        kind: "workspace_error",
        workspaceId: ws.wsId,
        issueNumber: ws.issueNumber ?? undefined,
        text: `Idle workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}) holds committed work but its base branch has moved. Run update-base then fix-and-merge to land it.`,
      });
      deps.boardEvents.broadcast(ws.projectId, "board_changed");
      return;
    }
    if (await mergeBlockedByBackoff(ws, deps)) return;
    if (!canStartMerge(ws)) return;
    console.log(`[monitor] Idle workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} has committed work on a stale base  attempting merge (falls back to fix-and-merge)`);
    await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
      conflictMsg: `[monitor] Stale-base workspace ${ws.wsId} could not merge cleanly  triggered fix-and-merge`,
      successMsg: `[monitor] Auto-recovered stale-base workspace ${ws.wsId} via merge`,
    }, RUN_GATE, mergeBackoffDeps(deps));
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (sessionCount >= MAX_SESSIONS) {
    const needsReviewStatusId = await getProjectStatusIdByName(ws.projectId, "Needs Review");
    const inReviewStatusId = await getProjectStatusIdByName(ws.projectId, "In Review");
    const fallbackStatusId = needsReviewStatusId ?? inReviewStatusId;
    if (fallbackStatusId) await transitionIssueStatus(db, ws.issueId, fallbackStatusId).catch((err) => console.warn(`[monitor] failed to move issue ${ws.issueId} to review fallback status:`, errorMessage(err)));
    await setWorkspaceStatus(db, ws.wsId, "closed");
    logAction("mark_idle", ws.wsId, ws.issueId, { responseSummary: `${sessionCount} sessions — flagged stuck`, verificationResult: "ok" });
    console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions  flagged as stuck, closing`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (sessionCount >= 5 && ws.issueStatusName === "In Review") {
    await setWorkspaceStatus(db, ws.wsId, "closed");
    logAction("mark_idle", ws.wsId, ws.issueId, { responseSummary: "Closed to break review loop", verificationResult: "ok" });
    console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions with issue in review  closing to break review loop (merge or create new workspace)`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (ws.issueStatusName === "In Review") {
    if (deps.autoMergeEnabled && deps.autoMergeInReview && !deps.autoMergeDisabledProjectIds?.has(ws.projectId)) {
      // #417: the backoff check runs BEFORE the pre-merge gate below — the gate is the
      // expensive verify/smoke run this circuit breaker exists to stop repeating.
      if (await mergeBlockedByBackoff(ws, deps)) return;
      // #821: the auto_merge_in_review path merges idle In-Review workspaces that are NOT
      // readyForMerge. The verify_script + smoke quality gate lived ONLY in the review-exit handler,
      // so this path bypassed it entirely — unverified/un-rendered code merged on hands-off projects.
      // Run the shared pre-merge gate HERE before merging un-ready work; on failure, WITHHOLD the
      // merge (leave In Review + log) rather than silently land it. (Work the review already approved
      // — readyForMerge=true — has passed the gate at review-exit, so skip the re-run for it.)
      // Build the explicit merge-gate PROOF token (arch-review §1.2): either the gate we run
      // right here for un-ready work, or the review-exit gate that set readyForMerge.
      let gateToken: MergeGateToken = gateTokenFromWorkspaceEvidence(ws, "review-exit gate (readyForMerge, auto_merge_in_review)");
      if (!ws.readyForMerge) {
        // #573: pin the state the gate is ABOUT to test, BEFORE it runs. The gate is a
        // 20-40 minute build+test run and nothing stops a still-active builder committing
        // into the worktree while it runs. Evidence minted WITHOUT shas falls back to
        // `evidenceIsValid`'s 15-minute age check, and `ranAt` is stamped at gate END — so
        // a commit landing mid-gate produced evidence that looked FRESH, and the moved tip
        // was merged having never been tested. The merge-gate and review-exit paths
        // already pin; these two monitor paths were the only ones that did not.
        const gateWorkspace = { id: ws.wsId, workingDir: ws.workingDir, baseBranch: ws.baseBranch };
        const gateShas = await resolveMergeGateShas(gateWorkspace);
        const gate = await runPreMergeGate(gateWorkspace, ws.projectId, db);
        if (!gate.passed) {
          console.log(`[monitor] Withholding auto_merge_in_review for idle In-Review workspace ${ws.wsId}  pre-merge gate failed (${gate.stage}): ${gate.message}`);
          emitButlerSystemEvent({
            projectId: ws.projectId,
            kind: "merge_failed",
            workspaceId: ws.wsId,
            issueNumber: ws.issueNumber ?? undefined,
            text: `Held idle In-Review workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}): pre-merge gate failed (${gate.stage}). ${gate.message.slice(0, 300)}`,
          });
          deps.boardEvents.broadcast(ws.projectId, "workflow_error");
          return;
        }
        if (!gate.skipped) console.log(`[monitor] Pre-merge gate passed for idle In-Review workspace ${ws.wsId} (${gate.stage}); proceeding with auto_merge_in_review`);
        gateToken = gateAlreadyPassed({
          ranAt: new Date().toISOString(),
          stage: gate.stage,
          source: "monitor-cycle gate (auto_merge_in_review)",
          branchSha: gateShas.branchSha,
          baseSha: gateShas.baseSha,
        });
      }
      if (!canStartMerge(ws)) return;
      await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
        conflictMsg: `[monitor] Merge conflict for idle In-Review workspace ${ws.wsId} (auto_merge_in_review)  triggered fix-and-merge`,
        successMsg: `[monitor] Auto-merged idle In-Review workspace ${ws.wsId} (auto_merge_in_review, not marked ready)`,
      }, gateToken, mergeBackoffDeps(deps));
      deps.boardEvents.broadcast(ws.projectId, "board_changed");
    } else {
      console.log(`[monitor] Skipping relaunch for idle workspace ${ws.wsId}  issue #${ws.issueNumber} is in review (committed work awaiting merge; enable auto_merge_in_review to land it)`);
    }
  } else {
    if (!canStartRelaunch(ws)) return;
    // #324: an empty workspace whose base moved gets rebased BEFORE the relaunch —
    // otherwise the agent re-runs against the same stale tree it already failed on
    // (observed: a loop step agent halting on an input file that had since landed
    // on the base branch; every bare relaunch failed identically). Best-effort:
    // a failed rebase falls through to the plain relaunch.
    let rebased = false;
    if (await hasMovedBaseNoCommits(ws, deps)) {
      try {
        await deps.workspaceActions.updateBase(ws.wsId, "rebase");
        rebased = true;
      } catch (err) {
        console.warn(`[monitor] update-base before relaunch failed for workspace ${ws.wsId}:`, errorMessage(err));
      }
    }
    let launchOk = true;
    try {
      await deps.workspaceActions.launch(ws.wsId);
    } catch {
      launchOk = false;
    }
    logAction("relaunch", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/launch`,
      verificationResult: launchOk ? "ok" : "failed",
      ...(rebased ? { responseSummary: "rebased onto moved base before relaunch" } : {}),
    });
    console.log(`[monitor] Relaunched idle workspace ${ws.wsId}${rebased ? " (rebased onto moved base first)" : ""}`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  }
}

async function handleReviewingWorkspace(ws: WorkspaceCandidate, sess: LatestSession | undefined, ctx: CycleContext): Promise<void> {
  const { deps, stats, logAction, canStartMerge } = ctx;
  if (isZeroDiffInReviewAwaiting(ws)) {
    console.log(`[monitor] Needs attention: idle-awaiting workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"} is In Review with no file changes and is not ready for merge`);
    return;
  }
  if (!ws.workingDir) {
    console.log(`[monitor] Ghost workspace ${ws.wsId} (workingDir empty)  deleting and resetting issue to In Progress`);
    // Delete failure is non-fatal here (mirrors the old fetch().catch(() => null)):
    // we still reset the issue to In Progress and log the action either way.
    await deps.workspaceActions.delete(ws.wsId).catch(() => {});
    const inProgressStatusId = await getProjectStatusIdByName(ws.projectId, "In Progress");
    if (inProgressStatusId) await transitionIssueStatus(db, ws.issueId, inProgressStatusId).catch((err) => console.warn(`[monitor] failed to reset ghost-workspace issue ${ws.issueId} to In Progress:`, errorMessage(err)));
    logAction("mark_idle", ws.wsId, ws.issueId, {
      endpoint: `DELETE /api/workspaces/${ws.wsId}`,
      responseSummary: "Ghost workspace deleted",
      verificationResult: "ok",
    });
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (sess?.status === "stopped") {
    if (!deps.autoMergeEnabled) {
      console.log(`[monitor] Skipping auto-merge for reviewing+stopped workspace ${ws.wsId}  auto_merge is disabled`);
      return;
    }
    if (deps.autoMergeDisabledProjectIds?.has(ws.projectId)) {
      console.log(`[monitor] Skipping auto-merge for reviewing+stopped workspace ${ws.wsId}  auto_merge_disabled for project ${ws.projectId}`);
      return;
    }
    // A reviewing workspace whose review session STOPPED should be readyForMerge if its gate passed.
    // If it isn't ready, run the shared pre-merge gate (#821) before landing — a non-zero verify or a
    // failed boot/render smoke WITHHOLDS the merge (leave In Review for re-review/fix). Work already
    // approved (readyForMerge=true) passed the gate at review-exit, so skip the re-run for it.
    // Build the explicit merge-gate PROOF token (arch-review §1.2): either the gate we run right
    // here for un-ready work, or the review-exit gate that set readyForMerge.
    let gateToken: MergeGateToken = gateTokenFromWorkspaceEvidence(ws, "review-exit gate (readyForMerge, reviewing+stopped)");
    if (!ws.readyForMerge) {
      // #573: pin before running (see the note on the auto_merge_in_review path above).
      // `baseBranch` was also omitted here, which degrades every diff-derived gate decision
      // to its most expensive branch (pre-merge-gate.service.ts:222-233) — the docs-only
      // skip and the test-package scoping can never fire without it.
      const gateWorkspace = { id: ws.wsId, workingDir: ws.workingDir, baseBranch: ws.baseBranch };
      const gateShas = await resolveMergeGateShas(gateWorkspace);
      const gate = await runPreMergeGate(gateWorkspace, ws.projectId, db);
      if (!gate.passed) {
        console.log(`[monitor] Withholding merge for reviewing+stopped workspace ${ws.wsId}  pre-merge gate failed (${gate.stage}): ${gate.message}`);
        emitButlerSystemEvent({
          projectId: ws.projectId,
          kind: "merge_failed",
          workspaceId: ws.wsId,
          issueNumber: ws.issueNumber ?? undefined,
          text: `Held reviewing+stopped workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}): pre-merge gate failed (${gate.stage}). ${gate.message.slice(0, 300)}`,
        });
        deps.boardEvents.broadcast(ws.projectId, "workflow_error");
        return;
      }
      gateToken = gateAlreadyPassed({
        ranAt: new Date().toISOString(),
        stage: gate.stage,
        source: "monitor-cycle gate (reviewing+stopped)",
        branchSha: gateShas.branchSha,
        baseSha: gateShas.baseSha,
      });
    }
    if (!canStartMerge(ws)) return;
    // Deliberately NO fix-and-merge fallback on this path: a reviewing
    // workspace whose merge fails must not spawn a fix-and-merge session.
    let mergeOk = true;
    try {
      await deps.workspaceActions.merge(ws.wsId, gateToken);
    } catch {
      mergeOk = false;
    }
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
      verificationResult: mergeOk ? "ok" : "failed",
    });
    console.log(`[monitor] Triggered merge for reviewing workspace ${ws.wsId}`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  }
}

/**
 * `blocked` means "needs a human" — with ONE exception, which used to be missing entirely
 * and is #387: a workspace parked here by `handleUsageLimitExit` is waiting on a clock, not
 * on a person. Before this, the cycle logged "skipping automation" and did nothing else, so
 * `latestSession` never changed, the stall classifier kept re-reading the same days-old
 * usage-limit stats row, and the workspace was wedged for good — measured on `eventhub`,
 * 18 workspaces blocked for up to 5 days while the same provider profile billed successful
 * sessions in the same project.
 *
 * Returning it to `idle` is the whole recovery: `handleIdleWorkspace` then relaunches or
 * merges it by the normal rules (including the WIP/relaunch caps), so this adds a state
 * transition rather than a second automation path. A workspace whose quota is genuinely
 * still exhausted simply dies on the limit again and re-blocks with a newer deadline.
 */
async function handleBlockedWorkspace(ws: WorkspaceCandidate, sess: LatestSession | undefined, ctx: CycleContext): Promise<void> {
  const { deps, logAction } = ctx;
  const quotaBlock = classifyQuotaBlock(sess, (deps.now ?? Date.now)());
  if (quotaBlock?.expired) {
    await setWorkspaceStatus(db, ws.wsId, "idle");
    logAction("mark_idle", ws.wsId, ws.issueId, {
      responseSummary: `provider quota block elapsed (release ${quotaBlock.releaseAt}) — returned to automation`,
      verificationResult: "ok",
    });
    console.log(`[monitor] Quota block elapsed for blocked workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}, release ${quotaBlock.releaseAt}); marking idle`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return;
  }
  const waiting = quotaBlock ? ` (provider quota block until ${quotaBlock.releaseAt})` : "";
  console.log(`[monitor] Needs attention: blocked workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"}; skipping automation${waiting}`);
}

async function handleActiveStoppedWorkspace(ws: WorkspaceCandidate, sess: LatestSession, ctx: CycleContext): Promise<void> {
  const { deps, logAction } = ctx;
  if (isCodexUsageLimitStats(sess.stats)) {
    await setWorkspaceStatus(db, ws.wsId, "blocked");
    console.log(`[monitor] Needs attention: active workspace ${ws.wsId} stopped after Codex usage limit; marking blocked`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return;
  }
  if (ws.isDirect) {
    await closeDirectWorkspaceAsDone(ws, logAction);
    console.log(`[monitor] Direct active workspace ${ws.wsId} has stopped session  closing`);
  } else {
    await setWorkspaceStatus(db, ws.wsId, "idle");
    logAction("mark_idle", ws.wsId, ws.issueId, { verificationResult: "ok" });
    console.log(`[monitor] Active workspace ${ws.wsId} has stopped session  marking idle for relaunch`);
  }
  deps.boardEvents.broadcast(ws.projectId, "board_changed");
}

async function handleActiveRunningWorkspace(ws: WorkspaceCandidate, sess: LatestSession, ctx: CycleContext): Promise<void> {
  const { deps, stats, logAction, stuckBuilderTimeoutMs } = ctx;
  if (!deps.sessionManager.isProcessAlive(sess.id)) {
    await setWorkspaceStatus(db, ws.wsId, "idle");
    await db.update(sessions).set({ status: "stopped", endedAt: new Date().toISOString() }).where(eq(sessions.id, sess.id)).catch(() => {});
    logAction("mark_dead", ws.wsId, ws.issueId, { verificationResult: "ok" });
    console.log(`[monitor] Workspace ${ws.wsId} process dead  marking idle`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return;
  } else if (Date.now() - new Date(sess.startedAt).getTime() > stuckBuilderTimeoutMs) {
    const recovered = await recoverStuckBuilder(ws, sess, deps, logAction);
    if (recovered) return;
    // A false return deliberately falls through to the nudge block below.
  }
  if (Date.now() - new Date(sess.startedAt).getTime() > 5 * 60 * 1000) {
    const previousNudge = deps.monitorRecentActions.find((a) => a.action === "nudge" && a.workspaceId === ws.wsId);
    if (previousNudge) {
      const excerpts = await deps.getRecentAgentExcerpts(sess.id);
      if (deps.shouldSkipNudge(excerpts)) {
        console.log(`[monitor] Skipping re-nudge for workspace ${ws.wsId}  agent appears to be actively working`);
        return;
      }
      if (excerpts.length > 0) console.log(`[monitor] Re-nudging workspace ${ws.wsId}  last agent excerpt: "${excerpts[0]?.slice(0, 100)}..."`);
      emitButlerSystemEvent({ projectId: ws.projectId, kind: "stuck_agent", workspaceId: ws.wsId, issueNumber: ws.issueNumber ?? undefined, text: `Agent on workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"} "${ws.issueTitle}") has been stuck without progress; monitor re-nudged.` });
    }
    const nudged = sendMonitorNudge({
      sessionManager: deps.sessionManager,
      sessionId: sess.id,
      workspaceId: ws.wsId,
      issueId: ws.issueId,
      projectId: ws.projectId,
      prompt: await deps.buildMonitorNudgePrompt(ws.projectId),
      logAction: (action, workspaceId, issueId) => logAction(action, workspaceId, issueId),
      broadcast: (projectId, event) => deps.boardEvents.broadcast(projectId, event),
    });
    if (nudged) stats.nudged++;
  }
}

export async function processWorkspaceCandidates(candidates: WorkspaceCandidate[], deps: ProcessWorkspaceDeps): Promise<ProcessWorkspaceCandidatesResult> {
  const stats = { relaunched: 0, merged: 0, nudged: 0 };
  const maxRelaunches = deps.maxRelaunchesPerCycle ?? MAX_MONITOR_RELAUNCHES_PER_CYCLE;
  const maxMerges = deps.maxMergesPerCycle ?? MAX_MONITOR_MERGES_PER_CYCLE;
  const stuckBuilderTimeoutMs = deps.stuckBuilderTimeoutMs ?? parseStuckBuilderTimeoutMs();
  const logAction: LogMonitorActionFn = (action, workspaceId, issueId, extra) => deps.logMonitorAction(deps.monitorRecentActions, action, workspaceId, issueId, extra);
  // Reserve the slot as part of the CHECK (not after the async action completes) so the
  // cap is enforced correctly even when different projects' candidate walks run
  // concurrently below — otherwise two concurrent walks could both pass the check before
  // either increments, overshooting the cycle cap.
  const canStartRelaunch = (ws: WorkspaceCandidate) => {
    if (stats.relaunched < maxRelaunches) { stats.relaunched++; return true; }
    console.log(`[monitor] Relaunch cap reached (${maxRelaunches}/cycle)  leaving workspace ${ws.wsId} idle until the next monitor run`);
    return false;
  };
  const canStartMerge = (ws: WorkspaceCandidate) => {
    if (stats.merged < maxMerges) { stats.merged++; return true; }
    console.log(`[monitor] Merge cap reached (${maxMerges}/cycle)  leaving workspace ${ws.wsId} queued until the next monitor run`);
    return false;
  };
  const ctx: CycleContext = { deps, stats, logAction, canStartRelaunch, canStartMerge, stuckBuilderTimeoutMs };

  async function processCandidate(ws: WorkspaceCandidate): Promise<void> {
    try {
      const [sess] = await db.select({ id: sessions.id, status: sessions.status, startedAt: sessions.startedAt, triggerType: sessions.triggerType, stats: sessions.stats }).from(sessions)
        .where(eq(sessions.workspaceId, ws.wsId)).orderBy(desc(sessions.startedAt)).limit(1);
      const sessionCountRows = await db.select({ count: sql<number>`count(*)` }).from(sessions)
        .where(and(
          eq(sessions.workspaceId, ws.wsId),
          or(isNull(sessions.triggerType), notInArray(sessions.triggerType, [...NOISE_TRIGGER_TYPES])),
        ));
      const sessionCount = Number(sessionCountRows[0]?.count ?? 0);

      if (ws.wsStatus === "idle") {
        await handleIdleWorkspace(ws, sess, sessionCount, ctx);
      } else if (ws.wsStatus === "reviewing") {
        await handleReviewingWorkspace(ws, sess, ctx);
      } else if (ws.wsStatus === "blocked") {
        await handleBlockedWorkspace(ws, sess, ctx);
      } else if (ws.wsStatus === "active" && sess?.status === "stopped") {
        await handleActiveStoppedWorkspace(ws, sess, ctx);
      } else if (ws.wsStatus === "active" && sess?.status === "running") {
        await handleActiveRunningWorkspace(ws, sess, ctx);
      }
    } catch (err) {
      console.warn(`[monitor] Error processing workspace ${ws.wsId}:`, err);
    }
  }

  const byProject = new Map<string, WorkspaceCandidate[]>();
  for (const ws of candidates) {
    const list = byProject.get(ws.projectId);
    if (list) list.push(ws); else byProject.set(ws.projectId, [ws]);
  }

  const now = deps.now ?? Date.now;
  const projectTimeBudgetMs = deps.projectTimeBudgetMs ?? DEFAULT_MONITOR_PROJECT_TIME_BUDGET_MS;
  const candidateTimeoutMs = deps.candidateTimeoutMs ?? DEFAULT_MONITOR_CANDIDATE_TIMEOUT_MS;
  const deferredProjectIds: string[] = [];

  /**
   * Await `work`, but give up after `timeoutMs` real milliseconds. A JS promise cannot
   * be cancelled, so the abandoned work keeps running detached — the point is only that
   * it no longer holds the cycle open (see `DEFAULT_MONITOR_CANDIDATE_TIMEOUT_MS`).
   * Returns `true` when the wait was abandoned.
   */
  function raceCandidateTimeout(work: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      timer.unref?.();
      work.then(
        () => { clearTimeout(timer); resolve(false); },
        () => { clearTimeout(timer); resolve(false); },
      );
    });
  }

  /** Returns true when the project's walk ran to completion (nothing deferred). */
  async function processProjectGroup(projectId: string, unordered: WorkspaceCandidate[]): Promise<boolean> {
    // Zero-cost decisions first, so the time budget below cannot starve them (#387).
    const wsList = orderCandidatesForWalk(unordered);
    const deadline = now() + projectTimeBudgetMs;
    for (let i = 0; i < wsList.length; i++) {
      if (now() > deadline) {
        const remaining = wsList.length - i;
        console.warn(`[monitor] Project ${projectId} exceeded its ${projectTimeBudgetMs}ms per-cycle time budget  deferring ${remaining} remaining candidate(s) to the next cycle`);
        deferredProjectIds.push(projectId);
        return false;
      }
      // PREEMPTIVE, unlike the deadline check above: a candidate that wedges inside an
      // unbounded await (hung git) must not keep the whole cycle — and therefore every
      // project's next cycle — from ever finishing.
      const abandoned = await raceCandidateTimeout(processCandidate(wsList[i]), candidateTimeoutMs);
      if (abandoned) {
        const remaining = wsList.length - i;
        console.warn(`[monitor] Workspace ${wsList[i].wsId} (project ${projectId}) did not finish within ${candidateTimeoutMs}ms  abandoning the wait and deferring ${remaining} remaining candidate(s) to the next cycle`);
        deferredProjectIds.push(projectId);
        return false;
      }
    }
    return true;
  }

  // Bounded concurrency ACROSS projects: unrelated projects' candidate walks are I/O and
  // subprocess bound, so they need not wait on each other. WITHIN a project, candidates
  // still process strictly sequentially (unchanged behavior) — only the per-project
  // deadline above lets us bail out of a single slow project's walk early.
  const groups = [...byProject.entries()];
  const concurrency = Math.max(1, Math.min(deps.projectConcurrency ?? DEFAULT_MONITOR_PROJECT_CONCURRENCY, groups.length || 1));
  const completedProjectIds: string[] = [];
  const notStartedProjectIds: string[] = [];
  const cycleDeadlineMs = deps.cycleDeadlineMs;
  let budgetTripLogged = false;
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= groups.length) return;
      const [projectId, wsList] = groups[idx];
      // #416: past the GLOBAL cycle deadline, start no new project sub-pass. Keep
      // draining the queue (cheaply) so every not-started project is recorded for the
      // scheduler's carry-over cursor.
      if (cycleDeadlineMs !== undefined && now() > cycleDeadlineMs) {
        if (!budgetTripLogged) {
          budgetTripLogged = true;
          console.warn(`[monitor] Global cycle budget exceeded — deferring ${groups.length - idx} remaining project sub-pass(es) to the next cycle (carry-over cursor resumes there)`);
        }
        notStartedProjectIds.push(projectId);
        continue;
      }
      const completed = await processProjectGroup(projectId, wsList);
      if (completed) completedProjectIds.push(projectId);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { ...stats, deferredProjectIds, completedProjectIds, notStartedProjectIds };
}
