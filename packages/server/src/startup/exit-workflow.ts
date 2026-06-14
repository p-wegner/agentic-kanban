import { isSpecPlanningStageName, syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { runSmokeCheck } from "@agentic-kanban/shared/lib/smoke-check";
import { buildSmokeCheck, getStackProfile } from "../services/stack-profile.service.js";
import { issues, preferences, projectStatuses, projects, scheduledRunHistory, scheduledRuns, sessions, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db as defaultDb } from "../db/index.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "../services/agent-settings.service.js";
import { createBoardEvents } from "../services/board-events.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import { ensureBuildableFromClean } from "../services/project-scaffold.js";
import * as gitService from "../services/git.service.js";
import { createSessionManager } from "../services/session.manager.js";
import { applyWorkspaceProfileToPrefs, buildReviewArgs, buildReviewPrompt, getEffectiveProfile, parseProviderPref } from "./review-helpers.js";
import type { MergeWorkspace } from "./merge-workflow.js";
import { isAutomaticMergeEnabled } from "./merge-strategy.js";
import type { Database } from "../db/index.js";
import { isCodexUsageLimitStats } from "../services/codex-rate-limit.js";
import { rotateCodexLicense } from "../services/codex-license-ring.js";
import { isClaudeUsageLimitStats } from "../services/claude-rate-limit.js";
import { rotateClaudeSubscription } from "../services/claude-subscription-ring.js";
import { buildLearningStepPrompt } from "../services/merge-helpers.service.js";
import { isFoundationalBlocker } from "../services/foundational-merge.service.js";
import { isColdCloneCheckEnabled, runColdCloneBuildCheckForProject } from "../services/cold-clone-build-check.service.js";
import type { ColdCloneCheckResult } from "../services/cold-clone-build-check.service.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

export interface WorkflowDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  autoMerge: (workspace: MergeWorkspace, projectId: string, issueId: string, doneStatusId: string | null, now: string) => Promise<void>;
  /** Injectable database for testing (defaults to the global singleton). */
  database?: Database;
}

async function waitForLearningSession(database: Database, learnSessId: string, label: string, timeoutMessage: string) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { console.log(timeoutMessage); resolve(); }, 3 * 60 * 1000);
    const poll = setInterval(async () => {
      const sessRows = await database.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learnSessId)).limit(1);
      if (sessRows.length > 0 && sessRows[0].status !== "running") {
        clearInterval(poll); clearTimeout(timeout);
        console.log(`[workflow] learning step (${label}) finished`); resolve();
      }
    }, 5000);
  });
}

async function launchLearningStep(database: Database, sessionManager: ReturnType<typeof createSessionManager>, learningSessionIds: Set<string>, workspace: { id: string; provider: string | null; claudeProfile: string | null }, prefMap: Map<string, string>, label: "after review" | "after agent", wait = false) {
  const workspaceId = workspace.id;
  try {
    // Run the learning step on the same provider/profile the workspace was built
    // with (e.g. its Codex OAuth license), not the global default which may have rotated.
    const learnPrefs = applyWorkspaceProfileToPrefs(prefMap, workspace);
    const provider = parseProviderPref(learnPrefs);
    const profile = learnPrefs.get("claude_profile") || undefined;
    const agentCommand = isMockProfile(profile) ? MOCK_AGENT_COMMAND : (learnPrefs.get("agent_command") || undefined);
    const agentArgs = learnPrefs.get("agent_args") || undefined;
    const claudeProfile = isMockProfile(profile) ? undefined : profile;
    const effectiveProfile = getEffectiveProfile(learnPrefs, provider, claudeProfile);
    const profileSelection = effectiveProfile ? { provider, name: effectiveProfile } : undefined;
    const prompt = buildLearningStepPrompt(false);
    const learnSessId = await sessionManager.startSession({ workspaceId, prompt, agentCommand, agentArgs, claudeProfile: effectiveProfile, provider: toExecutorProvider(provider), triggerType: "learning", profile: profileSelection });
    learningSessionIds.add(learnSessId);
    console.log(`[workflow] learning step (${label}) started: session=${learnSessId}`);
    return wait ? waitForLearningSession(database, learnSessId, label, `[workflow] learning step (${label}) timed out after 3m`) : Promise.resolve();
  } catch (err) {
    console.warn(`[workflow] learning step (${label}) failed (non-fatal):`, err);
    return Promise.resolve();
  }
}

async function hasCommittedChanges(workspace: WorkspaceRow, defaultBranch: string | null, workspaceId: string) {
  if (!workspace.workingDir) return false;
  try {
    if (workspace.isDirect) {
      const baseRef = workspace.baseCommitSha || "HEAD~1";
      return await new Promise<boolean>((resolve) => execFile("git", ["diff", "--quiet", baseRef, "HEAD"], { cwd: workspace.workingDir! }, (err: Error | null) => resolve(!!err)));
    }
    const baseBranch = workspace.baseBranch || defaultBranch;
    if (!baseBranch) {
      console.warn(`[workflow] workspace ${workspaceId} has no base/default branch; treating as no committed changes`);
      return false;
    }
    return await new Promise<boolean>((resolve) => execFile("git", ["diff", "--quiet", baseBranch], { cwd: workspace.workingDir! }, (err: Error | null) => resolve(!!err)));
  } catch { return false; }
}

/** Extract the "try again / resets at X" hint persisted on the rate-limited session's stats. */
function parseRateLimitRetryAfter(stats: string | null | undefined): string | null {
  if (!stats) return null;
  try {
    const parsed = JSON.parse(stats) as Record<string, unknown>;
    return typeof parsed.retryAfter === "string" ? parsed.retryAfter : null;
  } catch {
    return null;
  }
}

/** Build a continuation prompt so the rotated-to account picks the ticket back up in the same worktree. */
async function buildRotationContinuationPrompt(database: Database, issueId: string, providerLabel: string): Promise<string> {
  const rows = await database
    .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const issue = rows[0];
  const heading = issue ? `ticket #${issue.issueNumber}: ${issue.title}` : "your current ticket";
  return [
    `You are resuming work on ${heading}.`,
    `A previous ${providerLabel} session was interrupted by an account usage limit and has now resumed on a different ${providerLabel} account.`,
    "Your partial work is already in THIS worktree. First run `git status` and `git diff` to see what exists, then continue implementing the ticket to completion and COMMIT when done.",
    "",
    "Ticket description:",
    issue?.description || "(no description)",
  ].join("\n");
}

async function isSpecPlanningNode(database: Database, currentNodeId: string | null): Promise<boolean> {
  if (!currentNodeId) return false;
  const rows = await database
    .select({ name: workflowNodes.name })
    .from(workflowNodes)
    .where(eq(workflowNodes.id, currentNodeId))
    .limit(1);
  return isSpecPlanningStageName(rows[0]?.name);
}

export function createWorkflowEngine({ sessionManager, boardEvents, autoMerge, database }: WorkflowDeps) {
  const db = database ?? defaultDb;
  const reviewSessionIds = new Set<string>(), fixAndMergeSessionIds = new Set<string>(), learningSessionIds = new Set<string>();

  /**
   * #764 stranded-resolver guard. After a fix-and-merge resolver session exits, verify the
   * branch actually landed on its base. If it did NOT (the concurrent-merge loser whose
   * conflict against the moved base is real — autoMerge's plumbing merge threw and was
   * swallowed), make sure the workspace stays OPEN and idle so it is retryable, and clear the
   * stale readyForMerge flag so nothing re-treats a conflicted branch as mergeable. Never close
   * it — that is exactly the strand (ticket conflicted, no workspace) this guard prevents.
   *
   * Best-effort and idempotent: if the branch DID land, autoMerge has already closed the
   * workspace and this is a no-op (we only touch OPEN workspaces). If the ancestry check can't
   * run, we conservatively leave the open workspace idle (still retryable) rather than risk
   * stranding it.
   */
  async function keepResolverWorkspaceRetryableIfUnlanded(
    workspace: WorkspaceRow,
    projectId: string,
    issueId: string,
    defaultBranch: string | null,
    sessionId: string,
  ): Promise<void> {
    try {
      // Re-read the live workspace: autoMerge may have closed it on a successful landing.
      const freshRows = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
      const fresh = freshRows[0];
      // Already closed/merged (resolver succeeded) or worktree gone — nothing to keep open.
      if (!fresh || fresh.status === "closed" || fresh.mergedAt || !fresh.workingDir || fresh.isDirect) return;

      const baseBranch = fresh.baseBranch || defaultBranch;
      const repoRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const repoPath = repoRows[0]?.repoPath;

      let landed = false;
      if (baseBranch && repoPath) {
        try {
          const ancestry = await gitService.checkBranchTipIsAncestor(repoPath, fresh.branch, baseBranch, fresh.workingDir ?? undefined);
          landed = ancestry.isAncestor;
        } catch (err) {
          // Couldn't determine — assume NOT landed and keep it retryable (safe default).
          console.warn(`[workflow] #764 landing check failed for workspace ${workspace.id} (treating as not landed):`, err instanceof Error ? err.message : String(err));
        }
      }

      if (landed) return; // Branch is on base; resolver did its job (cleanup runs elsewhere).

      // Not landed: keep the workspace OPEN + idle and retryable. Clear readyForMerge so a
      // conflicted branch is not silently re-queued as "ready". Surface a clear signal.
      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "idle", readyForMerge: false, updatedAt: now }).where(eq(workspaces.id, workspace.id));
      boardEvents.broadcast(projectId, "workspace_idle");
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({
        projectId,
        kind: "merge_failed",
        workspaceId: workspace.id,
        text: `Fix-and-merge resolver for workspace ${workspace.id} (branch ${fresh.branch}) exited but the branch did not land on ${baseBranch ?? "base"} (likely a real concurrent-merge conflict). Workspace left open and idle for retry — not stranded.`,
      });
      console.warn(`[workflow] #764 fix-and-merge resolver for workspace ${workspace.id} (session ${sessionId}) did NOT land branch ${fresh.branch} on ${baseBranch ?? "base"} — kept open + idle for retry`);
    } catch (err) {
      console.warn(`[workflow] #764 stranded-resolver guard failed (non-fatal) for workspace ${workspace.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

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
          console.warn("[flaky-radar] auto-ingest failed (non-fatal):", err instanceof Error ? err.message : String(err));
        }
      })();

      // If the workspace was already merged (e.g. via HTTP merge endpoint while a
      // fix-and-merge session was still running), do not reset the status back to
      // "idle" — that would overwrite "closed" and strand the issue in "In Review".
      if (workspace.status === "closed" && workspace.mergedAt) {
        console.log(`[workflow] session ${sessionId} exited but workspace ${workspaceId} is already merged (mergedAt=${workspace.mergedAt}) — skipping exit workflow`);
        boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
        boardEvents.broadcast(projectId, "session_completed");
        fixAndMergeSessionIds.delete(sessionId);
        reviewSessionIds.delete(sessionId);
        learningSessionIds.delete(sessionId);
        return;
      }
      const sessionRows = await db.select({ stats: sessions.stats }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (isCodexUsageLimitStats(sessionRows[0]?.stats)) {
        // Codex license rotation: this account hit its quota. Stamp a cooldown on it
        // and switch `codex_profile` to the next available license, then relaunch the
        // workspace on the fresh account (a builder session continues its worktree;
        // review/fix sessions just get the switched pref and their own reconciler).
        const retryAfter = parseRateLimitRetryAfter(sessionRows[0]?.stats);
        const rotationPrefMap = new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
        const currentLicense = rotationPrefMap.get("codex_profile") || "default";
        const rotation = await rotateCodexLicense(db, rotationPrefMap, currentLicense, retryAfter, new Date(now));
        const isBuilderSession = !reviewSessionIds.has(sessionId) && !fixAndMergeSessionIds.has(sessionId) && !learningSessionIds.has(sessionId);

        if (rotation.rotated && rotation.toProfile && isBuilderSession) {
          try {
            const continuation = await buildRotationContinuationPrompt(db, issueId, "Codex");
            await db.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, workspaceId));
            const relaunchSessionId = await sessionManager.startSession({
              workspaceId,
              prompt: continuation,
              agentCommand: rotationPrefMap.get("agent_command") || undefined,
              agentArgs: rotationPrefMap.get("agent_args") || undefined,
              provider: "codex",
              triggerType: "agent",
              profile: { provider: "codex", name: rotation.toProfile },
            });
            boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
            boardEvents.broadcast(projectId, "issue_updated");
            emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Codex usage limit on '${rotation.fromProfile}' — rotated to '${rotation.toProfile}' and relaunched workspace ${workspaceId}.` });
            console.log(`[workflow] codex license rotated ${rotation.fromProfile} -> ${rotation.toProfile}; relaunched workspace ${workspaceId} session ${relaunchSessionId}`);
            return;
          } catch (err) {
            console.error("[workflow] codex license rotation relaunch failed:", err);
            // fall through to blocked
          }
        }

        await db.update(workspaces).set({ status: "blocked", updatedAt: now }).where(eq(workspaces.id, workspaceId));
        boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
        boardEvents.broadcast(projectId, "session_completed");
        boardEvents.broadcast(projectId, "workflow_error");
        const blockedReason = rotation.rotated
          ? `Codex usage limit reached for workspace ${workspaceId}; rotated codex_profile to '${rotation.toProfile}' (relaunch a builder manually).`
          : `Codex usage limit reached for workspace ${workspaceId}; ${rotation.reason}. Monitor will not relaunch it automatically.`;
        emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: blockedReason });
        console.warn(`[workflow] codex-rate-limited workspace ${workspaceId} from session ${sessionId} left blocked (${rotation.reason})`);
        return;
      }
      if (isClaudeUsageLimitStats(sessionRows[0]?.stats)) {
        // Claude subscription rotation: this Claude Max/Pro account hit its quota. Stamp
        // a cooldown on it and switch `claude_profile` to the next available subscription,
        // then relaunch the workspace on the fresh account (a builder session continues
        // its worktree; review/fix sessions just get the switched pref). Mirrors the
        // Codex license-rotation branch above.
        const resetsAt = parseRateLimitRetryAfter(sessionRows[0]?.stats);
        const rotationPrefMap = new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
        const currentSubscription = rotationPrefMap.get("claude_profile") || "default";
        const rotation = await rotateClaudeSubscription(db, rotationPrefMap, currentSubscription, resetsAt, new Date(now));
        const isBuilderSession = !reviewSessionIds.has(sessionId) && !fixAndMergeSessionIds.has(sessionId) && !learningSessionIds.has(sessionId);

        if (rotation.rotated && rotation.toProfile && isBuilderSession) {
          try {
            const continuation = await buildRotationContinuationPrompt(db, issueId, "Claude");
            await db.update(workspaces).set({ status: "active", updatedAt: now }).where(eq(workspaces.id, workspaceId));
            const relaunchSessionId = await sessionManager.startSession({
              workspaceId,
              prompt: continuation,
              agentCommand: rotationPrefMap.get("agent_command") || undefined,
              agentArgs: rotationPrefMap.get("agent_args") || undefined,
              claudeProfile: rotation.toProfile,
              provider: "claude-code",
              triggerType: "agent",
              profile: { provider: "claude", name: rotation.toProfile },
            });
            boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
            boardEvents.broadcast(projectId, "issue_updated");
            emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Claude usage limit on '${rotation.fromProfile}' — rotated to '${rotation.toProfile}' and relaunched workspace ${workspaceId}.` });
            console.log(`[workflow] claude subscription rotated ${rotation.fromProfile} -> ${rotation.toProfile}; relaunched workspace ${workspaceId} session ${relaunchSessionId}`);
            return;
          } catch (err) {
            console.error("[workflow] claude subscription rotation relaunch failed:", err);
            // fall through to blocked
          }
        }

        await db.update(workspaces).set({ status: "blocked", updatedAt: now }).where(eq(workspaces.id, workspaceId));
        boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
        boardEvents.broadcast(projectId, "session_completed");
        boardEvents.broadcast(projectId, "workflow_error");
        const blockedReason = rotation.rotated
          ? `Claude usage limit reached for workspace ${workspaceId}; rotated claude_profile to '${rotation.toProfile}' (relaunch a builder manually).`
          : `Claude usage limit reached for workspace ${workspaceId}; ${rotation.reason}. Monitor will not relaunch it automatically.`;
        emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: blockedReason });
        console.warn(`[workflow] claude-rate-limited workspace ${workspaceId} from session ${sessionId} left blocked (${rotation.reason})`);
        return;
      }
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
      boardEvents.broadcast(projectId, "session_completed");
      boardEvents.broadcast(projectId, "workspace_idle");
      // A read-only plan run produces no new commits, but the branch may already differ from
      // its base  which would otherwise trip the "committed changes  In Review  auto-review"
      // path below. The planimplement continuation is handled in session.manager, so skip the workflow.
      if (wasPlanMode) {
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
      const prefMap = new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
      const autoMergeEnabled = isAutomaticMergeEnabled(prefMap);
      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;

      const autoMergeDisabledProjectIds = new Set(
        [...prefMap]
          .filter(([key, value]) => /^auto_merge_disabled_[0-9a-f-]+$/.test(key) && value === "true")
          .map(([key]) => key.replace("auto_merge_disabled_", "")),
      );

      if (fixAndMergeSessionIds.has(sessionId)) {
        fixAndMergeSessionIds.delete(sessionId);
        if (exitCode === 0) {
          if (autoMergeDisabledProjectIds.has(projectId)) {
            console.log(`[workflow] fix-and-merge session ${sessionId} completed but auto_merge_disabled for project ${projectId} — skipping retry merge`);
            boardEvents.broadcast(projectId, "workspace_idle");
          } else {
            console.log(`[workflow] fix-and-merge session ${sessionId} completed  retrying merge`);
            // autoMerge swallows its own conflict errors, so its return tells us nothing.
            // The landing guard below is what verifies the branch actually merged.
            await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
          }
        } else {
          console.log(`[workflow] fix-and-merge session ${sessionId} exited with code ${exitCode}  not retrying merge`);
          boardEvents.broadcast(projectId, "workflow_error");
          emitButlerSystemEvent({ projectId, kind: "merge_failed", workspaceId, text: `Fix-and-merge session for workspace ${workspaceId} exited with code ${exitCode}.` });
        }
        // #764: stranded-resolver guard. A fix-and-merge resolver can exit (any code) WITHOUT
        // the branch landing — the concurrent-merge LOSER whose conflict against the moved base
        // is real, so autoMerge's plumbing merge throws and is swallowed. Left unchecked the
        // ticket ends up conflicted with NO open workspace to retry from (manual git recovery).
        // Verify the branch actually landed; if it did NOT, KEEP the workspace OPEN and idle
        // (retryable) and clear the stale readyForMerge flag so nothing treats a conflicted
        // branch as mergeable. Never close/strand it. (Acceptance for the concurrent-merge-loser
        // path; complements #761/#762.)
        await keepResolverWorkspaceRetryableIfUnlanded(workspace, projectId, issueId, defaultBranch, sessionId);
        return;
      }
      if (learningSessionIds.has(sessionId)) { learningSessionIds.delete(sessionId); console.log(`[workflow] learning step session ${sessionId} completed  no further workflow action`); return; }
      if (exitCode !== 0) {
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
          console.warn("[workflow] failure-pattern match failed (non-fatal):", fpErr instanceof Error ? fpErr.message : String(fpErr));
        }
        return;
      }
      if (reviewSessionIds.has(sessionId)) {
        reviewSessionIds.delete(sessionId);
        const currentIssueRows = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
        const currentStatus = currentIssueRows.length > 0 ? statuses.find((s) => s.id === currentIssueRows[0].statusId) : null;
        const autoFix = prefMap.get("review_auto_fix") !== "false";
        if (currentStatus?.name === "In Progress" && !autoFix) {
          console.log("[workflow] reviewer flagged issues (non-auto-fix mode)  skipping auto-merge, leaving in In Progress");
          boardEvents.broadcast(projectId, "issue_updated");
          return;
        }
        // #531 quality gate: run the project's verify_script (build/test/run) in the
        // worktree before approving for merge. Opt-in per project via the
        // verify_script_<projectId> preference — a pure no-op when unset, so existing
        // projects/the dev board are unaffected. A non-zero exit WITHHOLDS readyForMerge
        // so code that doesn't compile/test/run can't be auto-approved and merged
        // (the diff-only LLM review can't catch that on its own).
        const verifyScript = prefMap.get(`verify_script_${projectId}`);
        if (verifyScript && verifyScript.trim() && workspace.workingDir) {
          // #783: a builder that created package.json may not have approved native build
          // scripts (esbuild) or pinned a pnpm version that honors the approval — so a fresh
          // clone of master fails `pnpm install` even though the per-worktree gate passes
          // (the warm pnpm store hides it). Repair the manifest and COMMIT it onto the branch
          // BEFORE the verify build, so the fix merges to master and clones build clean.
          try {
            const approvalChanged = ensureBuildableFromClean(workspace.workingDir);
            if (approvalChanged) {
              // Only stage files that actually exist — `git add -- <missing>` fails the WHOLE
              // command on a missing pathspec (e.g. a single-package app has no
              // pnpm-workspace.yaml), which would otherwise throw and leave the manifest dirty.
              const candidatePaths = ["package.json", "pnpm-workspace.yaml"].filter((p) =>
                existsSync(join(workspace.workingDir!, p)),
              );
              const committed = candidatePaths.length
                ? await gitService.commitPaths(
                    workspace.workingDir,
                    candidatePaths,
                    "chore: pin pnpm + approve native build scripts (verify gate #783)",
                  )
                : false;
              if (committed) console.log(`[workflow] committed pnpm build-approval repair for workspace ${workspaceId} (#783)`);
            }
          } catch (e) {
            // Never let a repair failure leave the worktree dirty — an uncommitted manifest
            // change would block the auto-merge (silent merge loss). Revert and continue.
            console.warn(`[workflow] pnpm build-approval repair failed for workspace ${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
            try {
              await new Promise<void>((resolve) =>
                execFile("git", ["checkout", "--", "package.json", "pnpm-workspace.yaml"], { cwd: workspace.workingDir! }, () => resolve()),
              );
            } catch { /* best-effort cleanup */ }
          }
          const result = await runSetupScript(workspace.workingDir, verifyScript).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
          if (result.exitCode !== 0) {
            console.log(`[workflow] verify_script failed (exit ${result.exitCode}) for workspace ${workspaceId} — withholding readyForMerge`);
            boardEvents.broadcast(projectId, "workflow_error");
            emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Verify script failed (exit ${result.exitCode}) for workspace ${workspaceId}; not approved for merge. ${(result.stderr || result.stdout || "").slice(0, 300)}` });
            return;
          }
          console.log(`[workflow] verify_script passed for workspace ${workspaceId}`);
        }
        // #791 run/smoke gate: for a web/service project, boot the dev server and confirm it
        // responds (HTTP-200 + render). Derived entirely from the project's stack profile, so a
        // library/CLI project (no `isWeb`/dev command/health URL) yields no SmokeCheck and this is
        // a clean no-op. A failed boot/response WITHHOLDS readyForMerge — the diff-only LLM review
        // can't catch "compiles but doesn't boot". Generalizes the old `frontend-smoke.ps1`.
        if (workspace.workingDir) {
          try {
            const profile = await getStackProfile(projectId, db);
            const smokeCheck = buildSmokeCheck(profile);
            if (smokeCheck) {
              console.log(`[workflow] running smoke check for workspace ${workspaceId}: ${smokeCheck.devCommand} -> ${smokeCheck.healthUrl}`);
              const smoke = await runSmokeCheck(workspace.workingDir, smokeCheck);
              if (!smoke.passed) {
                console.log(`[workflow] smoke check failed for workspace ${workspaceId} — withholding readyForMerge: ${smoke.message}`);
                boardEvents.broadcast(projectId, "workflow_error");
                emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Smoke check failed for workspace ${workspaceId}; not approved for merge. ${smoke.message}` });
                return;
              }
              console.log(`[workflow] smoke check passed for workspace ${workspaceId}: ${smoke.message}`);
            }
          } catch (smokeErr) {
            // Non-fatal: a harness error must not block an otherwise-passing review. Log and proceed.
            console.warn(`[workflow] smoke check errored (non-fatal) for workspace ${workspaceId}:`, smokeErr instanceof Error ? smokeErr.message : String(smokeErr));
          }
        }
        // #792 cold-clone build check: the in-worktree verify gate above runs in a
        // dependency-symlinked worktree with a warm pnpm store, so it can pass even
        // when a FRESH clone of the branch would not build (the #783 class: unapproved
        // native build scripts, an unpinned package manager, an uncommitted generated
        // file). Opt-in per project via `cold_clone_check_<projectId>` — a pure no-op
        // when unset. Runs AFTER the verify block so it picks up any pnpm-approval
        // repair just committed onto the branch. A non-zero clean-build exit WITHHOLDS
        // readyForMerge so the #783 class is caught at review, not after merge.
        if (await isColdCloneCheckEnabled(projectId, db)) {
          const repoRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).limit(1);
          const repoPath = repoRows[0]?.repoPath;
          if (repoPath && workspace.branch) {
            const coldResult: ColdCloneCheckResult = await runColdCloneBuildCheckForProject(
              projectId,
              { repoPath, branch: workspace.branch },
              db,
            ).catch((e) => ({ ok: false, reason: "build-failed" as const, output: e instanceof Error ? e.message : String(e) }));
            if (!coldResult.ok) {
              const detail = coldResult.failedCommand ? `${coldResult.failedCommand} (exit ${coldResult.exitCode})` : coldResult.reason;
              console.log(`[workflow] cold-clone build check failed (${coldResult.reason}) for workspace ${workspaceId} — withholding readyForMerge (#792)`);
              boardEvents.broadcast(projectId, "workflow_error");
              emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Cold-clone build check failed for workspace ${workspaceId}: ${detail}. Builds in the worktree but not on a fresh clone (the #783 class); not approved for merge. ${(coldResult.output || "").slice(0, 300)}` });
              return;
            }
            console.log(`[workflow] cold-clone build check passed for workspace ${workspaceId} (#792)`);
          }
        }
        // #629 Guard: re-verify the branch still has committed changes ahead of base.
        // A race (e.g. branch reset/rebased to equal base between review start and exit)
        // can leave a 0-commit branch incorrectly marked ready-for-merge.
        const stillHasChanges = await hasCommittedChanges(workspace, defaultBranch, workspaceId);
        if (!stillHasChanges) {
          console.log(`[workflow] review session ${sessionId} completed but branch has no committed changes — withholding readyForMerge (issue #629)`);
          boardEvents.broadcast(projectId, "issue_updated");
          return;
        }
        await db.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));
        boardEvents.broadcast(projectId, "workspace_ready_for_merge");
        const learningAfterReview = prefMap.get("learning_step_after_review") === "true" && workspace.workingDir ? launchLearningStep(db, sessionManager, learningSessionIds, workspace, prefMap, "after review", true) : Promise.resolve();
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
            await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
          } else {
            console.log(`[workflow] review session ${sessionId} completed  queued for scheduled auto-merge`);
          }
        } else {
          await db.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));
          boardEvents.broadcast(projectId, "workspace_ready_for_merge");
          console.log(`[workflow] review session ${sessionId} completed  auto-merge disabled, marked ready_for_merge and left in In Review`);
          await learningAfterReview;
        }
        return;
      }

      const committedChanges = await hasCommittedChanges(workspace, defaultBranch, workspaceId);
      if (await isSpecPlanningNode(db, workspace.currentNodeId)) {
        console.log(`[workflow] planning phase session ${sessionId} completed; waiting for explicit user approval before advancing`);
        boardEvents.broadcast(projectId, "issue_updated");
        return;
      }
      // Direct workspaces with no committed changes: close immediately (nothing to review).
      // Direct workspaces WITH changes fall through to the review flow below.
      if (workspace.isDirect && !committedChanges) {
        const doneStatus = findStatus("Done");
        await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, workspaceId));
        if (doneStatus) {
          await db.update(issues).set({ statusId: doneStatus.id, updatedAt: now }).where(eq(issues.id, issueId));
          await syncCurrentNodeToStatus(db, issueId);
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
          await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, workspaceId));
          if (doneStatus) {
            await db.update(issues).set({ statusId: doneStatus.id, updatedAt: now }).where(eq(issues.id, issueId));
            await syncCurrentNodeToStatus(db, issueId);
          }
          boardEvents.broadcast(projectId, "workspace_merged");
          console.log(`[workflow] non-direct workspace ${workspaceId} closed on agent exit (no committed changes, was In Review)  issue moved to Done`);
          return;
        }
        console.log(`[workflow] agent session ${sessionId} completed but no committed changes  leaving issue in current status`);
        return;
      }
      console.log(`[workflow] agent session ${sessionId} completed with committed changes  moving to In Review`);
      const inReview = findStatus("In Review");
      if (inReview) {
        await db.update(issues).set({ statusId: inReview.id, updatedAt: now }).where(eq(issues.id, issueId));
        await syncCurrentNodeToStatus(db, issueId);
      }
      boardEvents.broadcast(projectId, "issue_updated");
      if (prefMap.get("learning_step_after_agent") === "true" && workspace.workingDir) await launchLearningStep(db, sessionManager, learningSessionIds, workspace, prefMap, "after agent");
      const autoReview = !skipAutoReview && (workspace.requiresReview || prefMap.get("auto_review") !== "false");
      if (!autoReview) return;

      // Review on the same provider/profile the workspace was built with (e.g. its
      // Codex OAuth license), not the global default which may have rotated since.
      const reviewPrefs = applyWorkspaceProfileToPrefs(prefMap, workspace);
      const reviewProvider = parseProviderPref(reviewPrefs), reviewProfile = reviewPrefs.get("claude_profile") || undefined;
      const agentCommand = isMockProfile(reviewProfile) ? MOCK_AGENT_COMMAND : (reviewPrefs.get("agent_command") || undefined);
      const claudeProfile = isMockProfile(reviewProfile) ? undefined : reviewProfile;
      const effectiveReviewProfile = getEffectiveProfile(reviewPrefs, reviewProvider, claudeProfile);
      const profileSelection = effectiveReviewProfile ? { provider: reviewProvider, name: effectiveReviewProfile } : undefined;
      const reviewArgs = buildReviewArgs(reviewPrefs, reviewProvider), autoFix = workspace.isDirect ? false : reviewPrefs.get("review_auto_fix") !== "false";
      let diffRef = workspace.baseBranch || defaultBranch, conflictingFiles: string[] | undefined, uncommittedChanges: string[] | undefined;
      if (workspace.isDirect) diffRef = workspace.baseCommitSha || defaultBranch;
      else if (workspace.workingDir) {
        const baseBranch = workspace.baseBranch || defaultBranch;
        if (!baseBranch) { console.warn(`[workflow] cannot launch review for workspace ${workspaceId}: no base/default branch configured`); return; }
        const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
        diffRef = prep.diffRef;
        if (!prep.success) {
          conflictingFiles = prep.conflictingFiles; uncommittedChanges = prep.uncommittedChanges;
          console.warn(`[workflow] rebase failed for workspace ${workspaceId}: ${prep.error}  reviewer will resolve conflicts`);
        }
      }
      const reviewSkillName = workspace.thoroughReview ? "code-review-thorough" : "code-review";
      const verifyAgent = prefMap.get("after_merge_verify_agent") || "none";
      const { prompt, model } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, conflictingFiles, uncommittedChanges, workspaceId, reviewSkillName, verifyAgent);
      const reviewArgsWithModel = model && reviewProvider === "claude" ? `${reviewArgs ?? ""} --model ${model}`.trim() : reviewArgs;
      try {
        await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
        boardEvents.broadcast(projectId, "issue_updated");
        const reviewSessionId = await sessionManager.startSession({ workspaceId, prompt, agentCommand, agentArgs: reviewArgsWithModel, claudeProfile: effectiveReviewProfile, provider: toExecutorProvider(reviewProvider), triggerType: "review", profile: profileSelection, extraEnv: { KANBAN_SESSION_TYPE: "review", KANBAN_AFTER_MERGE_VERIFY: verifyAgent } });
        reviewSessionIds.add(reviewSessionId);
        console.log(`[workflow] launched ${reviewSkillName} session ${reviewSessionId} for workspace ${workspaceId} (verifyAgent=${verifyAgent})`);
      } catch (err) {
        console.error("[workflow] Failed to launch review session:", err);
        // Do NOT swallow this and leave the workspace stuck at "reviewing" with no
        // running session (the #529 stranding). Reset to idle and surface the failure;
        // the stranded-review reconciler then re-launches it instead of it sitting
        // forever as never-reviewed / not-mergeable.
        await db.update(workspaces).set({ status: "idle", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId)).catch(() => {});
        boardEvents.broadcast(projectId, "workflow_error");
        emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Auto-review failed to launch for workspace ${workspaceId}; reset to idle for recovery.` });
      }
    } catch (err) {
      console.error("[workflow] onSessionExit error:", err);
    }
  }
  return { runWorkflowOnExit, reviewSessionIds, fixAndMergeSessionIds, learningSessionIds };
}
