/**
 * The session-exit workflow engine: what the board does when an agent session ends.
 *
 * This module is the DISPATCHER plus the terminal handlers that own board policy — which is what
 * is left after #700 gave each self-contained sub-protocol its own module in `./exit/`:
 *
 *   ./exit/usage-limit-exit.ts    the provider-quota path (rotate the ring, relaunch or block)
 *   ./exit/fix-and-merge-exit.ts  the resolver path (retry the merge, then verify it landed, #764)
 *   ./exit/review-launch.ts       starting a review session (reservation, profile ladder, #529)
 *   ./exit/clean-clone-checks.ts  clean-clone buildability of the branch (#812 repair, #792 gate)
 *   ./exit/learning-step.ts       the compounding-engineering learning step
 *   ./exit/exit-context.ts        the snapshot type the dispatcher hands every handler
 *
 * Each of those is a factory taking an explicit deps object, so the boundary is a real dependency
 * contract rather than a re-export: the collaborators a sub-protocol needs (the rotation rings,
 * the review prompt builder, the cold-clone checker) are imported by that module alone and are
 * invisible here. What stays is the part that cannot be pulled apart without hiding policy — the
 * one snapshot load, the classification, and the handlers the classification selects between.
 */
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { isSpecPlanningStageName, transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { AUTO_REVIEW_PREF_KEY, isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import { RUN_GATE } from "../services/pre-merge-gate.service.js";
import { runGateWithEvidence } from "../services/merge-gate-evidence.js";
import { getAutoLandLoopTicket } from "../services/plugin-loop-hooks.service.js";
import { reconcileGroupMemberIssues } from "../services/merge-cleanup.service.js";
import { issues, projectStatuses, projects, scheduledRunHistory, scheduledRuns, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
import { getCommitCountAhead as commitsAhead } from "@agentic-kanban/shared/lib/git-service";
import { db as defaultDb } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import * as realGitService from "../services/git.service.js";
import type { GitService } from "../services/workspace-internals.js";
import { createSessionManager } from "../services/session.manager.js";
import { isAutomaticMergeEnabled } from "./merge-strategy.js";
import type { Database } from "../db/index.js";
import { classifySessionExit, resolveSessionRoleFlags } from "./session-exit-classification.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";
import { isFoundationalBlocker } from "../services/foundational-merge.service.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";
import { findUncommittedWork } from "./uncommitted-work-report.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { createCleanCloneChecks } from "./exit/clean-clone-checks.js";
import { createFixAndMergeExitHandler } from "./exit/fix-and-merge-exit.js";
import { createReviewLauncher } from "./exit/review-launch.js";
import { createUsageLimitExitHandler, findUsageLimitProvider } from "./exit/usage-limit-exit.js";
import { launchLearningStep } from "./exit/learning-step.js";
import type { AutoMergeFn, ExitContext, WorkspaceRow } from "./exit/exit-context.js";
import { graphOwnsPostExitReview } from "./exit/workflow-ownership.js";
import { getWorkflowNodeById, getWorkspaceCurrentWorkflowNode } from "../repositories/workflow.repository.js";

const autoMergeDisabledPref = projectPref("auto_merge_disabled");

export interface WorkflowDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  autoMerge: AutoMergeFn;
  /**
   * #1000: reconcile a fork child that already sits on its join node (agent
   * called propose_transition) but never got marked "joined" — the cross-process
   * notify that normally does that has no delivery guarantee and can lose the
   * race against this very session-exit status write. Called (best-effort) after
   * a fork child's session exits into blocked/failed. Optional so tests that
   * don't exercise fork workflows can omit it.
   */
  reconcileForkChildOnExit?: (workspaceId: string) => Promise<void>;
  /** Injectable database for testing (defaults to the global singleton). */
  database?: Database;
  /**
   * Injectable git service (#558), the same dep the ten workspace services already take.
   * Defaults to the real one. A test passing a partial fake here does not have to
   * `vi.mock` the 60-export git.service module — which also mocks it for every transitive
   * importer of that module in the same file.
   */
  gitService?: GitService;
}

async function hasCommittedChanges(workspace: WorkspaceRow, defaultBranch: string | null, workspaceId: string, database: Database) {
  // #539: the leading-OR-sibling probe now lives in one place (services/workspace-commits).
  // `onUnknown: true` because "no commits" licenses CLOSING the workspace and forcing the
  // issue Done further down this file — acting on an unknown here destroys work.
  return workspaceHasCommittedWork(
    { id: workspaceId, workingDir: workspace.workingDir, baseBranch: workspace.baseBranch, isDirect: workspace.isDirect, baseCommitSha: workspace.baseCommitSha },
    defaultBranch,
    database,
    { onUnknown: true },
  );
}

async function isSpecPlanningNode(database: Database, currentNodeId: string | null): Promise<boolean> {
  if (!currentNodeId) return false;
  const node = await getWorkflowNodeById(currentNodeId, database);
  return isSpecPlanningStageName(node?.name);
}

/**
 * #997/#757 Guard: is this workspace's CURRENT workflow stage owned by the graph rather than by
 * the legacy `triggerType:"review"` pipeline?
 *
 * The predicate itself (and the argument for where the line falls) lives in
 * `./exit/workflow-ownership.ts`. Two things are deliberate here:
 *
 *  - The node is re-read from the DB rather than taken from the exit snapshot. The builder-exit
 *    path transitions the issue to In Review DURING this pass, and `syncCurrentNodeToStatus`
 *    re-points `workspaces.currentNodeId` at the In-Review-mapped node; the snapshot still names
 *    the builder stage, so trusting it would classify every builder exit as graph-owned (#757).
 *  - It STACKS with `isSpecPlanningNode` above rather than replacing it: that one is narrower
 *    (spec-planning stage names only) but fires EARLIER in handleBuilderSessionExit, before the
 *    learning step and the auto-land path.
 */
async function graphOwnsWorkspaceReview(database: Database, workspaceId: string): Promise<boolean> {
  return graphOwnsPostExitReview(await getWorkspaceCurrentWorkflowNode(workspaceId, database));
}

export function createWorkflowEngine({ sessionManager, boardEvents, autoMerge, reconcileForkChildOnExit, database, gitService: injectedGitService }: WorkflowDeps) {
  const db = database ?? defaultDb;
  const gitService = injectedGitService ?? realGitService;
  const reviewSessionIds = new Set<string>(), fixAndMergeSessionIds = new Set<string>(), learningSessionIds = new Set<string>();

  const handleUsageLimitExit = createUsageLimitExitHandler({ database: db, sessionManager, boardEvents, reconcileForkChildOnExit });
  const { handleFixAndMergeExit } = createFixAndMergeExitHandler({ database: db, gitService, boardEvents, autoMerge, fixAndMergeSessionIds });
  const { applyBuildApprovalRepair, runColdCloneGate } = createCleanCloneChecks({ database: db, gitService, boardEvents });
  const { launchAutoReview } = createReviewLauncher({ database: db, gitService, sessionManager, boardEvents, reviewSessionIds });
  const learningStepDeps = { database: db, sessionManager, learningSessionIds };

  async function runWorkflowOnExit(workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) {
    try {
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (wsRows.length === 0) return;
      const workspace = wsRows[0];
      const issueRows = await db.select({ projectId: issues.projectId, id: issues.id, skipAutoReview: issues.skipAutoReview }).from(issues).where(eq(issues.id, workspace.issueId)).limit(1);
      if (issueRows.length === 0) return;
      const { projectId, id: issueId, skipAutoReview } = issueRows[0];
      const now = new Date().toISOString();

      // Auto-ingest any test results from this session's output into the flaky-test
      // radar (non-fatal, fire-and-forget). Robust to non-test sessions — they yield
      // nothing. Idempotent per session, so a re-exit won't double-count.
      void (async () => {
        try {
          const { createTestRunService } = await import("../services/test-run.service.js");
          const inserted = await createTestRunService(db).ingestSession(sessionId);
          if (inserted > 0) console.log(`[flaky-radar] auto-ingested ${inserted} test result(s) from session ${sessionId}`);
        } catch (err) {
          console.warn("[flaky-radar] auto-ingest failed (non-fatal):", errorMessage(err));
        }
      })();

      // If the workspace was already merged (e.g. via HTTP merge endpoint while a
      // fix-and-merge session was still running), do not reset the status back to
      // "idle" — that would overwrite "closed" and strand the issue in "In Review".
      // #1003: a fork child is closed by its JOIN (forkStatus "joined"/"cancelled"), never
      // individually merged — so it is "closed" with mergedAt null. Without this second
      // condition, the child's own CLI process exiting after the join already closed it
      // raced setWorkspaceStatus(..., "idle") past the terminal guard (which only protects
      // closed+mergedAt), leaving status="idle" with closedAt still stamped from the join.
      const forkTerminalStatuses = new Set(["joined", "cancelled", "failed"]);
      if (workspace.status === "closed" && (workspace.mergedAt || (workspace.forkStatus && forkTerminalStatuses.has(workspace.forkStatus)))) {
        console.log(`[workflow] session ${sessionId} exited but workspace ${workspaceId} is already closed (mergedAt=${workspace.mergedAt}, forkStatus=${workspace.forkStatus}) — skipping exit workflow`);
        boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
        boardEvents.broadcast(projectId, "session_completed");
        fixAndMergeSessionIds.delete(sessionId);
        reviewSessionIds.delete(sessionId);
        learningSessionIds.delete(sessionId);
        return;
      }
      // Provider usage-limit rotation (Codex license / Claude subscription): this
      // account hit its quota. Cool it down, switch to the next available profile, and
      // relaunch a builder on the fresh account (review/fix sessions inherit the switched
      // pref and rely on their own reconciler). Both providers share one implementation,
      // parameterized by the provider table in ./exit/usage-limit-exit.ts.
      const sessionRows = await db.select({ stats: sessions.stats, triggerType: sessions.triggerType }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      // #950: resolve the session's role from the in-memory sets (fast path) AND the
      // persisted sessions.triggerType (source of truth that survives restarts). A
      // reattached review/fix-and-merge/learning session exits into EMPTY sets — the
      // DB value keeps it from being misrouted to the builder handler.
      const roleFlags = resolveSessionRoleFlags(sessionId, sessionRows[0]?.triggerType, { reviewSessionIds, fixAndMergeSessionIds, learningSessionIds });
      // One read of the stats discriminant picks the provider config (#542), instead of
      // asking each provider's predicate whether the blob is its own.
      const usageLimitCfg = findUsageLimitProvider(sessionRows[0]?.stats);
      if (usageLimitCfg) {
        await handleUsageLimitExit({ cfg: usageLimitCfg, workspaceId, sessionId, issueId, projectId, now, statsJson: sessionRows[0]?.stats, roleFlags });
        return;
      }
      // Route the (non-already-merged, non-usage-limited) exit to exactly one terminal
      // handler. The pure `classifySessionExit` decision core (#855) computes the verdict
      // so the priority between the cases is table-testable; every side effect below stays
      // here, in the same order as the original control flow.
      const classification = classifySessionExit({
        wasPlanMode: wasPlanMode ?? false,
        isFixAndMerge: roleFlags.isFixAndMerge,
        isLearning: roleFlags.isLearning,
        isReview: roleFlags.isReview,
        exitCode,
      });
      // #966: the closed+mergedAt check above ran on a snapshot read ~60 lines earlier —
      // a merge landing in between must NOT be flapped back to idle. setWorkspaceStatus
      // enforces the terminal invariant atomically in its UPDATE's WHERE clause, so a
      // `false` here means a concurrent terminal transition (or vanished row) won the
      // race: stop the exit workflow instead of running it against a merged workspace.
      const wentIdle = await setWorkspaceStatus(db, workspaceId, "idle", { now });
      boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
      boardEvents.broadcast(projectId, "session_completed");
      if (!wentIdle) {
        console.log(`[workflow] session ${sessionId} exited but workspace ${workspaceId} reached a terminal state before the idle write (#966) — skipping exit workflow`);
        fixAndMergeSessionIds.delete(sessionId);
        reviewSessionIds.delete(sessionId);
        learningSessionIds.delete(sessionId);
        return;
      }
      boardEvents.broadcast(projectId, "workspace_idle");
      // A read-only plan run produces no new commits, but the branch may already differ from
      // its base  which would otherwise trip the "committed changes  In Review  auto-review"
      // path below. The planimplement continuation is handled in session.manager, so skip the workflow.
      if (classification.action === "plan-mode-skip") {
        console.log(`[workflow] plan-mode session ${sessionId} completed  skipping review/merge workflow`);
        return;
      }
      try {
        const runRows = await db.select({ id: scheduledRuns.id }).from(scheduledRuns).where(eq(scheduledRuns.lastRunWorkspaceId, workspaceId)).limit(1);
        if (runRows.length > 0) {
          const status = exitCode === 0 ? "success" : "error";
          await db.update(scheduledRuns).set({ lastRunStatus: status, updatedAt: now }).where(eq(scheduledRuns.id, runRows[0].id));
          const historyRows = await db
            .select({ id: scheduledRunHistory.id })
            .from(scheduledRunHistory)
            .where(eq(scheduledRunHistory.workspaceId, workspaceId))
            .orderBy(desc(scheduledRunHistory.startedAt))
            .limit(1);
          if (historyRows.length > 0) {
            await db.update(scheduledRunHistory).set({
              status,
              reason: exitCode === 0 ? null : `Agent session exited with code ${exitCode}`,
              completedAt: now,
            }).where(eq(scheduledRunHistory.id, historyRows[0].id));
          }
        }
      } catch (err) { console.warn("[workflow] failed to update scheduled run status:", err); }

      const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      const findStatus = (name: string) => statuses.find((s) => s.name === name);
      const prefMap = toPrefMap(await getAllPreferencesCached(db));
      const autoMergeEnabled = isAutomaticMergeEnabled(prefMap);
      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;

      const autoMergeDisabledProjectIds = new Set(
        [...prefMap]
          .filter(([key, value]) => autoMergeDisabledPref.projectIdOf(key) !== null && value === "true")
          .map(([key]) => key.replace("auto_merge_disabled_", "")),
      );

      const ctx: ExitContext = { workspace, projectId, issueId, skipAutoReview, sessionId, exitCode, now, prefMap, statuses, findStatus, autoMergeEnabled, defaultBranch, autoMergeDisabledProjectIds };
      if (classification.action === "fix-and-merge") { await handleFixAndMergeExit(ctx); return; }
      if (classification.action === "learning-cleanup") { learningSessionIds.delete(sessionId); console.log(`[workflow] learning step session ${sessionId} completed  no further workflow action`); return; }
      if (classification.action === "failed") { await handleFailedSessionExit(ctx); return; }
      if (classification.action === "review") { await handleReviewSessionExit(ctx); return; }
      await handleBuilderSessionExit(ctx);
    } catch (err) {
      console.error("[workflow] onSessionExit error:", err);
    }
  }

  async function handleFailedSessionExit(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, sessionId, exitCode } = ctx;
    const workspaceId = workspace.id;
    emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Agent session for workspace ${workspaceId} ended with non-zero exit code ${exitCode}.` });
    // Surface similar past failures as a board comment
    try {
      const { extractSessionStderr, findSimilarFailures } = await import("../services/failure-pattern.service.js");
      const stderrText = await extractSessionStderr(sessionId);
      if (stderrText.trim()) {
        const matches = await findSimilarFailures(stderrText);
        if (matches.length > 0) {
          const commentLines = [
            `🔍 **Failure pattern memory**: this session's errors resemble past incidents:`,
            ...matches.map((m, i) =>
              `${i + 1}. **${m.pattern.title}** (${Math.round(m.score * 100)}% match)` +
              (m.pattern.rootCause ? `\n   _Root cause_: ${m.pattern.rootCause.slice(0, 200)}` : "") +
              (m.pattern.fix ? `\n   _Fix_: ${m.pattern.fix.slice(0, 200)}` : "") +
              (m.pattern.sourceRef ? `\n   _Source_: ${m.pattern.sourceRef}` : ""),
            ),
          ];
          const { createDiffComment } = await import("../repositories/session.repository.js");
          await createDiffComment(
            workspaceId,
            { filePath: ".failure-patterns", body: commentLines.join("\n\n"), lineNumOld: null, lineNumNew: null },
            db,
          );
          boardEvents.broadcast(projectId, "issue_updated");
        }
      }
    } catch (fpErr) {
      console.warn("[workflow] failure-pattern match failed (non-fatal):", errorMessage(fpErr));
    }
  }

  /**
   * Arm `readyForMerge` and persist the merge-gate evidence quartet (#182/#243/#540).
   *
   * ONE writer for what used to be two near-identical nine-line object literals in
   * `handleReviewSessionExit` — the auto-merge-enabled path and the auto-merge-disabled path —
   * whose only real difference was whether the evidence may be trusted. `trustworthy: false`
   * (a tip moved DURING the gate run) nulls the whole quartet rather than leaving a ranAt/stage
   * the merge path would honour on age alone for code the gate never saw. `ranAt` is the moment
   * the gate FINISHED, never `ctx.now`, which predates the gate by its entire runtime.
   */
  async function armReadyForMerge(
    workspaceId: string,
    projectId: string,
    evidence: { ranAt: string; stage: string; source: string; branchSha: string | null; baseSha: string | null; trustworthy: boolean },
  ): Promise<void> {
    await db.update(workspaces).set({
      readyForMerge: true,
      updatedAt: evidence.ranAt,
      mergeGateRanAt: evidence.trustworthy ? evidence.ranAt : null,
      mergeGateStage: evidence.trustworthy ? evidence.stage : null,
      mergeGateSource: evidence.trustworthy ? evidence.source : null,
      mergeGateBranchSha: evidence.branchSha,
      mergeGateBaseSha: evidence.baseSha,
    }).where(eq(workspaces.id, workspaceId));
    boardEvents.broadcast(projectId, "workspace_ready_for_merge");
  }

  async function handleReviewSessionExit(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, issueId, sessionId, now, prefMap, statuses, findStatus, autoMergeEnabled, defaultBranch, autoMergeDisabledProjectIds } = ctx;
    const workspaceId = workspace.id;
    reviewSessionIds.delete(sessionId);
    // #997 defensive guard: a stray/legacy review session exiting while the workspace sits on a
    // graph-owned workflow stage must not arm readyForMerge — the graph owns merge eligibility
    // there. #757 narrowed "graph-owned": a node MAPPED to the In Review status is the graph
    // saying "review this", and nothing in the graph launches or lands that review, so the
    // legacy path is its executor and readyForMerge is armed on a branch the workflow did mean
    // to review.
    if (await graphOwnsWorkspaceReview(db, workspaceId)) {
      console.log(`[workflow] review session ${sessionId} exited but workspace ${workspaceId} sits on a graph-owned workflow stage  withholding readyForMerge (#997/#757)`);
      boardEvents.broadcast(projectId, "issue_updated");
      return;
    }
    const currentIssueRows = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    const currentStatus = currentIssueRows.length > 0 ? statuses.find((s) => s.id === currentIssueRows[0].statusId) : null;
    const autoFix = getBool(prefMap, "review_auto_fix");
    if (currentStatus?.name === "In Progress" && !autoFix) {
      console.log("[workflow] reviewer flagged issues (non-auto-fix mode)  skipping auto-merge, leaving in In Progress");
      boardEvents.broadcast(projectId, "issue_updated");
      return;
    }
    // Pre-merge gate (arch-review §1.2): the verify (#531) + smoke (#791) checks now run through
    // the SINGLE shared owner `runPreMergeGate` — the SAME gate the manual/monitor merge paths run
    // — instead of an inline copy that had to be kept "in sync". The #812 build-approval repair
    // still runs FIRST (it must commit its fix onto the branch before the verify build); the #792
    // cold-clone check stays a separate opt-in gate. Any failure WITHHOLDS readyForMerge.
    await applyBuildApprovalRepair(ctx);
    const gateWorkspace = { id: workspaceId, workingDir: workspace.workingDir, baseBranch: workspace.baseBranch || defaultBranch };
    // #540: pin → gate → re-pin → mint, via the ONE owner of the #243 protocol. `ranAt` is
    // stamped at gate END, never from `ctx.now` (captured at the START of runWorkflowOnExit,
    // 30-45 minutes earlier on a repo whose verify gate is a full suite + build — evidence
    // stamped with it was born older than MERGE_GATE_EVIDENCE_MAX_AGE_MS and could never be
    // accepted, so every merge re-ran the whole gate).
    const preMergeGate = await runGateWithEvidence({
      workspace: gateWorkspace,
      projectId,
      source: "review-exit gate",
      database: db,
    });
    if (!preMergeGate.passed) {
      console.log(`[workflow] pre-merge gate failed (${preMergeGate.stage}) for workspace ${workspaceId} — withholding readyForMerge: ${preMergeGate.message}`);
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Pre-merge gate failed (${preMergeGate.stage}) for workspace ${workspaceId}; not approved for merge. ${preMergeGate.message.slice(0, 300)}` });
      return;
    }
    const gateRanAt = preMergeGate.ranAt;
    // Content-key the persisted evidence (0108), so the monitor's later merge trigger can
    // trust a pass whose only sin is age while still re-gating when the base has moved. A gate
    // whose worktree moved under it produced no trustworthy proof — the whole evidence quartet
    // is cleared rather than left with a ranAt/stage the merge path would honour on age alone.
    const tipMovedDuringGate = preMergeGate.moved;
    if (tipMovedDuringGate) {
      console.warn(`[workflow] pre-merge gate passed for workspace ${workspaceId} but the ${tipMovedDuringGate} moved DURING the run — persisting no gate evidence (#243)`);
    }
    const gateShas = tipMovedDuringGate ? {} : preMergeGate.shasBefore;
    if (!(await runColdCloneGate(ctx))) return;
    // #629 Guard: re-verify the branch still has committed changes ahead of base.
    // A race (e.g. branch reset/rebased to equal base between review start and exit)
    // can leave a 0-commit branch incorrectly marked ready-for-merge.
    const stillHasChanges = await hasCommittedChanges(workspace, defaultBranch, workspaceId, db);
    if (!stillHasChanges) {
      console.log(`[workflow] review session ${sessionId} completed but branch has no committed changes — withholding readyForMerge (issue #629)`);
      boardEvents.broadcast(projectId, "issue_updated");
      return;
    }
    // Persist the REAL gate evidence (ranAt/stage) alongside readyForMerge — this is what the
    // monitor's later auto-merge trigger reads to build honest `MergeGateEvidence` instead of
    // fabricating `ranAt: new Date()` at merge time (#182).
    const evidence = {
      ranAt: gateRanAt,
      stage: preMergeGate.stage,
      source: "review-exit gate",
      branchSha: gateShas.branchSha ?? null,
      baseSha: gateShas.baseSha ?? null,
    };
    await armReadyForMerge(workspaceId, projectId, { ...evidence, trustworthy: !tipMovedDuringGate });
    const learningAfterReview = getBool(prefMap, "learning_step_after_review") && workspace.workingDir ? launchLearningStep(learningStepDeps, workspace, prefMap, "after review", true) : Promise.resolve();
    if (autoMergeEnabled) {
      await learningAfterReview;
      // #797 synchronous foundational merge. A no-dependency scaffold/shell ticket that
      // gates open tier-1 work must land PROMPTLY — not sit Done-but-unmerged until the
      // next 30s auto-merge-orchestrator tick — or a dependent could be cut from the
      // pre-merge (empty) base on the very first cascade cycle. #784's read-side mergedAt
      // gate makes dependents WAIT; this makes the foundational merge land NOW so the wait
      // is short. Non-foundational tickets keep deferring to the scheduled orchestrator
      // (its batch/cluster reconciliation handles overlap/conflict residue).
      const autoMergeDisabledHere = autoMergeDisabledProjectIds.has(projectId);
      if (!autoMergeDisabledHere && await isFoundationalBlocker(db, issueId)) {
        console.log(`[workflow] review session ${sessionId} completed  foundational blocker — merging synchronously (#797)`);
        // Merge-gate DECISION (arch-review §1.2): the shared verify/smoke gate ran (and passed)
        // moments ago above, so hand autoMerge that PROOF as an `already-passed` token — it won't
        // re-run the expensive build. Stale/absent proof would force a re-gate in resolveMergeGate.
        // The token is pinned to the tips the gate verified — the proof stays valid through an
        // arbitrary lock wait but is voided the moment the base moves under it. It is null when
        // there is nothing worth trusting (a tip moved during the run, or nothing was gated), and
        // then RUN_GATE makes the executor decide for itself. #540 fixed the old branch here: it
        // minted sha-less evidence for a run whose tip HAD moved, i.e. proof accepted on age alone
        // for code the gate never saw — the exact thing `armReadyForMerge`'s `trustworthy` nulls.
        await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now,
          preMergeGate.token ?? RUN_GATE);
      } else {
        console.log(`[workflow] review session ${sessionId} completed  queued for scheduled auto-merge`);
      }
    } else {
      await armReadyForMerge(workspaceId, projectId, { ...evidence, trustworthy: true });
      console.log(`[workflow] review session ${sessionId} completed  auto-merge disabled, marked ready_for_merge and left in In Review`);
      await learningAfterReview;
    }
  }

  async function handleBuilderSessionExit(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, issueId, sessionId, skipAutoReview, now, prefMap, statuses, findStatus, defaultBranch } = ctx;
    const workspaceId = workspace.id;
    const committedChanges = await hasCommittedChanges(workspace, defaultBranch, workspaceId, db);
    if (await isSpecPlanningNode(db, workspace.currentNodeId)) {
      console.log(`[workflow] planning phase session ${sessionId} completed; waiting for explicit user approval before advancing`);
      boardEvents.broadcast(projectId, "issue_updated");
      return;
    }
    // Direct workspaces with no committed changes: close immediately (nothing to review).
    // Direct workspaces WITH changes fall through to the review flow below.
    if (workspace.isDirect && !committedChanges) {
      const doneStatus = findStatus("Done");
      // #547: the documented close transition, which stamps `closedAt` — a raw
      // setWorkspaceStatus(…, "closed") does not, and that column is what issue-activity,
      // project-activity, workspace-timeline, the digest route and the handoff bundle read.
      // `markMerged: false`: a direct workspace with no committed changes merged nothing.
      await closeWorkspace({ database: db, workspaceId, now, markMerged: false });
      // #226 — workingDir is a leading-repo mirror column; clear it through the helper that
      // writes the `repos` row too, not through `closeWorkspace({ clearWorkingDir: true })`
      // (which nulls the workspace column only and cannot mirror).
      await clearWorkspaceWorkingDir(workspaceId, now, db);
      if (doneStatus) {
        await transitionIssueStatus(db, issueId, doneStatus.id, { now });
        // Ticket group (#661): members of a closing group workspace converge with the lead.
        await reconcileGroupMemberIssues({ database: db, workspaceId, now, projectId });
      }
      boardEvents.broadcast(projectId, "workspace_merged");
      console.log(`[workflow] direct workspace ${workspaceId} closed on agent exit (no committed changes)  issue moved to Done`);
      return;
    }
    if (!committedChanges) {
      // If the issue is already In Review with no committed changes, the workspace
      // is a zero-diff dead-end: no code to review, no merge possible. Close it and
      // move to Done so it doesn't block the Done transition (issue #603).
      const currentIssueRows2 = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
      const currentStatusName2 = currentIssueRows2.length > 0 ? statuses.find((s) => s.id === currentIssueRows2[0].statusId)?.name : undefined;
      if (currentStatusName2 === "In Review") {
        const doneStatus = findStatus("Done");
        // The issue only reaches In Review AFTER committedChanges was true (the builder
        // produced work). "No committed changes now, was In Review" therefore means the
        // work already LANDED (a sibling-only ticket's auto-merge cleans its branch, so a
        // later exit pass sees the leading repo clean and the sibling branch gone). Stamp
        // mergedAt via closeWorkspace(markMerged) instead of setWorkspaceStatus, which left
        // mergedAt null and made a genuinely-merged workspace read as not-merged to the
        // merge-queue guard / analytics (#74). Genuinely-empty workspaces never reach In
        // Review — they fall through to the "leaving issue in current status" branch below.
        await closeWorkspace({ database: db, workspaceId, now, markMerged: true, clearWorkingDir: true });
        if (doneStatus) {
          await transitionIssueStatus(db, issueId, doneStatus.id, { now });
          // Ticket group (#661): the landed group closes every member ticket too.
          await reconcileGroupMemberIssues({ database: db, workspaceId, now, projectId });
        }
        boardEvents.broadcast(projectId, "workspace_merged");
        console.log(`[workflow] non-direct workspace ${workspaceId} closed on agent exit (no committed changes, was In Review, work already landed  mergedAt stamped)  issue moved to Done`);
        return;
      }
      // #469 — a dirty worktree with no commits means the work was DONE and never committed,
      // which is otherwise indistinguishable from success here. See uncommitted-work-report.ts.
      const uncommitted = await findUncommittedWork(workspace.workingDir);
      if (uncommitted) {
        console.warn(`[workflow] session ${sessionId} exited with UNCOMMITTED work in ${workspace.workingDir} (${uncommitted.paths.length} path(s)) — recoverable by relaunching`);
        emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: uncommitted.summary });
        boardEvents.broadcast(projectId, "workflow_error");
        return;
      }
      console.log(`[workflow] agent session ${sessionId} completed but no committed changes  leaving issue in current status`);
      return;
    }
    console.log(`[workflow] agent session ${sessionId} completed with committed changes  moving to In Review`);
    const inReview = findStatus("In Review");
    if (inReview) {
      await transitionIssueStatus(db, issueId, inReview.id, { now });
    }
    boardEvents.broadcast(projectId, "issue_updated");
    // #297 — a loop whose manifest opted into autoLand lands its ticket NOW instead of
    // parking it at In Review until a human (or the off-by-default auto_merge_in_review
    // pref) merges it. Still gated: RUN_GATE makes autoMerge run the same verify/smoke
    // pre-merge gate as every other landing. The post-merge loop advance (#298) then
    // fires from the merge tail, so the loop's next gate appears without the monitor.
    const autoLandLoop = await getAutoLandLoopTicket(issueId, db);
    if (autoLandLoop) {
      // #325 kept a local commits-ahead re-check here because `committedChanges` above was a
      // working-tree diff against the base BRANCH TIP, so a workspace with ZERO unique
      // commits read as "changed" whenever the base moved under it. #365 fixed that at the
      // source (hasCommittedChanges now counts commits), so this is now belt-and-braces
      // rather than the only line of defence — kept because auto-landing an empty loop
      // workspace closes the unit's ticket with no artifacts, and the planner's external-key
      // dedupe then deadlocks the loop ("Waiting on input", every re-advance a no-op).
      const unitCommitsAhead = workspace.workingDir && workspace.baseBranch
        ? await commitsAhead(workspace.workingDir, workspace.baseBranch)
        : null;
      if (unitCommitsAhead === 0) {
        console.log(`[workflow] NOT auto-landing loop ticket for ${autoLandLoop.pluginSlug}:${autoLandLoop.loopName} (unit ${autoLandLoop.unitId}) — workspace has no unique commits; leaving the ticket open for recovery`);
        // Back out of the In Review transition made above: In Review + zero diff is a
        // monitor dead-end ("needs attention"), while In Progress re-enters the
        // relaunch path (which now rebases a moved base first, #324).
        const inProgress = findStatus("In Progress");
        if (inProgress) await transitionIssueStatus(db, issueId, inProgress.id, { now });
        emitButlerSystemEvent({
          projectId,
          kind: "merge_failed",
          workspaceId,
          text: `Loop unit ${autoLandLoop.pluginSlug}:${autoLandLoop.loopName}:${autoLandLoop.unitId} finished with NO unique commits — not landing the empty workspace (would close the unit without its artifacts and deadlock the loop). The monitor will rebase and relaunch it.`,
        });
        boardEvents.broadcast(projectId, "workflow_error");
        return;
      }
      console.log(`[workflow] loop ticket for ${autoLandLoop.pluginSlug}:${autoLandLoop.loopName} (unit ${autoLandLoop.unitId}) auto-lands (manifest autoLand)`);
      await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now, RUN_GATE);
      return;
    }
    if (getBool(prefMap, "learning_step_after_agent") && workspace.workingDir) await launchLearningStep(learningStepDeps, workspace, prefMap, "after agent");
    // #997/#757: skip the legacy auto-review only when the graph really owns the next stage.
    // Re-read the node — the In Review transition above just re-pointed it (see
    // graphOwnsWorkspaceReview). A stage the graph owns but has no machinery for would strand
    // the workspace at `idle` with no review and no error, which is the #757 regression.
    if (await graphOwnsWorkspaceReview(db, workspaceId)) {
      console.log(`[workflow] workspace ${workspaceId} sits on a graph-owned workflow stage  skipping legacy auto-review (#997/#757)`);
      return;
    }
    // #998: a fork child (parentWorkspaceId set, or forkStatus stamped) is an ephemeral
    // sub-branch consolidated by its JOIN — it must never be auto-reviewed or get
    // readyForMerge on its own. Without this guard, a child that already joined can be
    // picked up here on its own session exit and flipped back to idle/reviewing.
    if (workspace.parentWorkspaceId || workspace.forkStatus) {
      console.log(`[workflow] workspace ${workspaceId} is a fork child (parentWorkspaceId=${workspace.parentWorkspaceId ?? "n/a"}, forkStatus=${workspace.forkStatus ?? "n/a"})  skipping legacy auto-review (#998)`);
      return;
    }
    const autoReview = !skipAutoReview && (workspace.requiresReview || isAutoReviewEnabled(prefMap.get(AUTO_REVIEW_PREF_KEY)));
    if (!autoReview) return;
    await launchAutoReview(ctx);
  }

  return { runWorkflowOnExit, reviewSessionIds, fixAndMergeSessionIds, learningSessionIds };
}
