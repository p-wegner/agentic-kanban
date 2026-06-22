import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq, sql, or, isNull, notInArray, and } from "drizzle-orm";
import { db } from "../db/index.js";
import type { createBoardEvents } from "../services/board-events.js";
import { sendMonitorNudge, type MonitorActionName } from "../services/monitor-nudge.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import type { createSessionManager } from "../services/session.manager.js";
import type { MonitorAction } from "./monitor-helpers.js";
import { NOISE_TRIGGER_TYPES } from "../services/session-filter.js";
import { commitLeftoverChanges, getCommitCountAhead, getWorkingTreeDiff } from "../services/git.service.js";
import { startManualReview } from "../services/review.service.js";
import { isCodexUsageLimitStats } from "../services/codex-rate-limit.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getStackProfile, verifyScriptPrefKey } from "../services/stack-profile.service.js";
import { runPreMergeGate } from "../services/pre-merge-gate.service.js";
import {
  MAX_SESSIONS,
  NON_TRIVIAL_WORKTREE_DIFF_CHARS,
  hasRepeatedFailedCommand,
  isBuilderSession,
  isZeroDiffInReviewAwaiting,
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

export { DEFAULT_STUCK_BUILDER_TIMEOUT_MS } from "./monitor-cycle-rules.js";

export const MAX_MONITOR_RELAUNCHES_PER_CYCLE = 2;
export const MAX_MONITOR_MERGES_PER_CYCLE = 2;

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
  getWorkingTreeDiff?: typeof getWorkingTreeDiff;
  commitLeftoverChanges?: typeof commitLeftoverChanges;
  startReview?: typeof startManualReview;
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
  await db.update(workspaces).set({ status: "idle", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId));

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
    await db.update(issues).set({ statusId: inReviewStatusId, updatedAt: new Date().toISOString() }).where(eq(issues.id, ws.issueId));
    await syncCurrentNodeToStatus(db, ws.issueId);
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

async function handleIdleWorkspace(ws: WorkspaceCandidate, sess: LatestSession | undefined, sessionCount: number, ctx: CycleContext): Promise<void> {
  const { deps, stats, logAction, canStartRelaunch, canStartMerge } = ctx;
  if (isCodexUsageLimitStats(sess?.stats)) {
    await db.update(workspaces).set({ status: "blocked", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
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
    if (!canStartMerge(ws)) return;
    await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
      conflictMsg: `[monitor] Merge conflict for idle+readyForMerge workspace ${ws.wsId}  triggered fix-and-merge`,
      successMsg: `[monitor] Triggered merge for idle+readyForMerge workspace ${ws.wsId}`,
    });
    stats.merged++;
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (sessionCount >= MAX_SESSIONS) {
    const needsReviewStatusId = await getProjectStatusIdByName(ws.projectId, "Needs Review");
    const inReviewStatusId = await getProjectStatusIdByName(ws.projectId, "In Review");
    const fallbackStatusId = needsReviewStatusId ?? inReviewStatusId;
    if (fallbackStatusId) await db.update(issues).set({ statusId: fallbackStatusId }).where(eq(issues.id, ws.issueId)).catch(() => {});
    await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
    logAction("mark_idle", ws.wsId, ws.issueId, { responseSummary: `${sessionCount} sessions — flagged stuck`, verificationResult: "ok" });
    console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions  flagged as stuck, closing`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (sessionCount >= 5 && ws.issueStatusName === "In Review") {
    await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
    logAction("mark_idle", ws.wsId, ws.issueId, { responseSummary: "Closed to break review loop", verificationResult: "ok" });
    console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions with issue in review  closing to break review loop (merge or create new workspace)`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  } else if (ws.issueStatusName === "In Review") {
    if (deps.autoMergeEnabled && deps.autoMergeInReview && !deps.autoMergeDisabledProjectIds?.has(ws.projectId)) {
      // #821: the auto_merge_in_review path merges idle In-Review workspaces that are NOT
      // readyForMerge. The verify_script + smoke quality gate lived ONLY in the review-exit handler,
      // so this path bypassed it entirely — unverified/un-rendered code merged on hands-off projects.
      // Run the shared pre-merge gate HERE before merging un-ready work; on failure, WITHHOLD the
      // merge (leave In Review + log) rather than silently land it. (Work the review already approved
      // — readyForMerge=true — has passed the gate at review-exit, so skip the re-run for it.)
      if (!ws.readyForMerge) {
        const gate = await runPreMergeGate({ id: ws.wsId, workingDir: ws.workingDir }, ws.projectId, db);
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
      }
      if (!canStartMerge(ws)) return;
      await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
        conflictMsg: `[monitor] Merge conflict for idle In-Review workspace ${ws.wsId} (auto_merge_in_review)  triggered fix-and-merge`,
        successMsg: `[monitor] Auto-merged idle In-Review workspace ${ws.wsId} (auto_merge_in_review, not marked ready)`,
      });
      stats.merged++;
      deps.boardEvents.broadcast(ws.projectId, "board_changed");
    } else {
      console.log(`[monitor] Skipping relaunch for idle workspace ${ws.wsId}  issue #${ws.issueNumber} is in review (committed work awaiting merge; enable auto_merge_in_review to land it)`);
    }
  } else {
    if (!canStartRelaunch(ws)) return;
    let launchOk = true;
    try {
      await deps.workspaceActions.launch(ws.wsId);
    } catch {
      launchOk = false;
    }
    stats.relaunched++;
    logAction("relaunch", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/launch`,
      verificationResult: launchOk ? "ok" : "failed",
    });
    console.log(`[monitor] Relaunched idle workspace ${ws.wsId}`);
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
    if (inProgressStatusId) await db.update(issues).set({ statusId: inProgressStatusId }).where(eq(issues.id, ws.issueId)).catch(() => {});
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
    if (!ws.readyForMerge) {
      const gate = await runPreMergeGate({ id: ws.wsId, workingDir: ws.workingDir }, ws.projectId, db);
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
    }
    if (!canStartMerge(ws)) return;
    // Deliberately NO fix-and-merge fallback on this path: a reviewing
    // workspace whose merge fails must not spawn a fix-and-merge session.
    let mergeOk = true;
    try {
      await deps.workspaceActions.merge(ws.wsId);
    } catch {
      mergeOk = false;
    }
    stats.merged++;
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
      verificationResult: mergeOk ? "ok" : "failed",
    });
    console.log(`[monitor] Triggered merge for reviewing workspace ${ws.wsId}`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
  }
}

async function handleActiveStoppedWorkspace(ws: WorkspaceCandidate, sess: LatestSession, ctx: CycleContext): Promise<void> {
  const { deps, logAction } = ctx;
  if (isCodexUsageLimitStats(sess.stats)) {
    await db.update(workspaces).set({ status: "blocked", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
    console.log(`[monitor] Needs attention: active workspace ${ws.wsId} stopped after Codex usage limit; marking blocked`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return;
  }
  if (ws.isDirect) {
    await closeDirectWorkspaceAsDone(ws, logAction);
    console.log(`[monitor] Direct active workspace ${ws.wsId} has stopped session  closing`);
  } else {
    await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
    logAction("mark_idle", ws.wsId, ws.issueId, { verificationResult: "ok" });
    console.log(`[monitor] Active workspace ${ws.wsId} has stopped session  marking idle for relaunch`);
  }
  deps.boardEvents.broadcast(ws.projectId, "board_changed");
}

async function handleActiveRunningWorkspace(ws: WorkspaceCandidate, sess: LatestSession, ctx: CycleContext): Promise<void> {
  const { deps, stats, logAction, stuckBuilderTimeoutMs } = ctx;
  if (!deps.sessionManager.isProcessAlive(sess.id)) {
    await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
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

export async function processWorkspaceCandidates(candidates: WorkspaceCandidate[], deps: ProcessWorkspaceDeps): Promise<{ relaunched: number; merged: number; nudged: number }> {
  const stats = { relaunched: 0, merged: 0, nudged: 0 };
  const maxRelaunches = deps.maxRelaunchesPerCycle ?? MAX_MONITOR_RELAUNCHES_PER_CYCLE;
  const maxMerges = deps.maxMergesPerCycle ?? MAX_MONITOR_MERGES_PER_CYCLE;
  const stuckBuilderTimeoutMs = deps.stuckBuilderTimeoutMs ?? parseStuckBuilderTimeoutMs();
  const logAction: LogMonitorActionFn = (action, workspaceId, issueId, extra) => deps.logMonitorAction(deps.monitorRecentActions, action, workspaceId, issueId, extra);
  const canStartRelaunch = (ws: WorkspaceCandidate) => {
    if (stats.relaunched < maxRelaunches) return true;
    console.log(`[monitor] Relaunch cap reached (${maxRelaunches}/cycle)  leaving workspace ${ws.wsId} idle until the next monitor run`);
    return false;
  };
  const canStartMerge = (ws: WorkspaceCandidate) => {
    if (stats.merged < maxMerges) return true;
    console.log(`[monitor] Merge cap reached (${maxMerges}/cycle)  leaving workspace ${ws.wsId} queued until the next monitor run`);
    return false;
  };
  const ctx: CycleContext = { deps, stats, logAction, canStartRelaunch, canStartMerge, stuckBuilderTimeoutMs };
  for (const ws of candidates) {
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
        console.log(`[monitor] Needs attention: blocked workspace ${ws.wsId} for issue #${ws.issueNumber ?? "?"}; skipping automation`);
        continue;
      } else if (ws.wsStatus === "active" && sess?.status === "stopped") {
        await handleActiveStoppedWorkspace(ws, sess, ctx);
      } else if (ws.wsStatus === "active" && sess?.status === "running") {
        await handleActiveRunningWorkspace(ws, sess, ctx);
      }
    } catch (err) {
      console.warn(`[monitor] Error processing workspace ${ws.wsId}:`, err);
    }
  }
  return stats;
}
