import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { issues, preferences, projectStatuses, projects, scheduledRuns, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { db } from "../db/index.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "../services/agent-settings.service.js";
import { createBoardEvents } from "../services/board-events.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import * as gitService from "../services/git.service.js";
import { createSessionManager } from "../services/session.manager.js";
import { buildReviewArgs, buildReviewPrompt, getEffectiveProfile, parseProviderPref } from "./review-helpers.js";
import type { MergeWorkspace } from "./merge-workflow.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

export interface WorkflowDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  autoMerge: (workspace: MergeWorkspace, projectId: string, issueId: string, doneStatusId: string | null, now: string) => Promise<void>;
}

async function waitForLearningSession(learnSessId: string, label: string, timeoutMessage: string) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { console.log(timeoutMessage); resolve(); }, 3 * 60 * 1000);
    const poll = setInterval(async () => {
      const sessRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learnSessId)).limit(1);
      if (sessRows.length > 0 && sessRows[0].status !== "running") {
        clearInterval(poll); clearTimeout(timeout);
        console.log(`[workflow] learning step (${label}) finished`); resolve();
      }
    }, 5000);
  });
}

async function launchLearningStep(sessionManager: ReturnType<typeof createSessionManager>, learningSessionIds: Set<string>, workspaceId: string, prefMap: Map<string, string>, label: "after review" | "after agent", wait = false) {
  try {
    const provider = parseProviderPref(prefMap);
    const profile = prefMap.get("claude_profile") || undefined;
    const agentCommand = isMockProfile(profile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
    const agentArgs = prefMap.get("agent_args") || undefined;
    const claudeProfile = isMockProfile(profile) ? undefined : profile;
    const effectiveProfile = getEffectiveProfile(prefMap, provider, claudeProfile);
    const profileSelection = effectiveProfile ? { provider, name: effectiveProfile } : undefined;
    const prompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks.`;
    const learnSessId = await sessionManager.startSession({ workspaceId, prompt, agentCommand, agentArgs, claudeProfile: effectiveProfile, provider: toExecutorProvider(provider), triggerType: "learning", profile: profileSelection });
    learningSessionIds.add(learnSessId);
    console.log(`[workflow] learning step (${label}) started: session=${learnSessId}`);
    return wait ? waitForLearningSession(learnSessId, label, `[workflow] learning step (${label}) timed out after 3m`) : Promise.resolve();
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

export function createWorkflowEngine({ sessionManager, boardEvents, autoMerge }: WorkflowDeps) {
  const reviewSessionIds = new Set<string>(), fixAndMergeSessionIds = new Set<string>(), learningSessionIds = new Set<string>();
  async function runWorkflowOnExit(workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) {
    try {
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (wsRows.length === 0) return;
      const workspace = wsRows[0];
      const issueRows = await db.select({ projectId: issues.projectId, id: issues.id, skipAutoReview: issues.skipAutoReview }).from(issues).where(eq(issues.id, workspace.issueId)).limit(1);
      if (issueRows.length === 0) return;
      const { projectId, id: issueId, skipAutoReview } = issueRows[0];
      const now = new Date().toISOString();
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
        if (runRows.length > 0) await db.update(scheduledRuns).set({ lastRunStatus: exitCode === 0 ? "success" : "error", updatedAt: now }).where(eq(scheduledRuns.id, runRows[0].id));
      } catch (err) { console.warn("[workflow] failed to update scheduled run status:", err); }

      const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      const findStatus = (name: string) => statuses.find((s) => s.name === name);
      const prefMap = new Map((await db.select().from(preferences)).map((r) => [r.key, r.value]));
      const autoMergeEnabled = prefMap.get("auto_merge") !== "false";
      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;

      if (fixAndMergeSessionIds.has(sessionId)) {
        fixAndMergeSessionIds.delete(sessionId);
        if (exitCode === 0) {
          console.log(`[workflow] fix-and-merge session ${sessionId} completed  retrying merge`);
          await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
        } else {
          console.log(`[workflow] fix-and-merge session ${sessionId} exited with code ${exitCode}  not retrying merge`);
          boardEvents.broadcast(projectId, "workflow_error");
          emitButlerSystemEvent({ projectId, kind: "merge_failed", workspaceId, text: `Fix-and-merge session for workspace ${workspaceId} exited with code ${exitCode}.` });
        }
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
        const learningAfterReview = prefMap.get("learning_step_after_review") === "true" && workspace.workingDir ? launchLearningStep(sessionManager, learningSessionIds, workspace.id, prefMap, "after review", true) : Promise.resolve();
        if (autoMergeEnabled) {
          console.log(`[workflow] review session ${sessionId} completed  auto-merging (learning step runs in parallel)`);
          await Promise.all([autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now), learningAfterReview]);
        } else {
          console.log(`[workflow] review session ${sessionId} completed  auto-merge disabled, leaving in In Review`);
          await learningAfterReview;
        }
        return;
      }

      const committedChanges = await hasCommittedChanges(workspace, defaultBranch, workspaceId);
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
      if (!committedChanges) { console.log(`[workflow] agent session ${sessionId} completed but no committed changes  leaving issue in current status`); return; }
      console.log(`[workflow] agent session ${sessionId} completed with committed changes  moving to In Review`);
      const inReview = findStatus("In Review");
      if (inReview) {
        await db.update(issues).set({ statusId: inReview.id, updatedAt: now }).where(eq(issues.id, issueId));
        await syncCurrentNodeToStatus(db, issueId);
      }
      boardEvents.broadcast(projectId, "issue_updated");
      if (prefMap.get("learning_step_after_agent") === "true" && workspace.workingDir) await launchLearningStep(sessionManager, learningSessionIds, workspace.id, prefMap, "after agent");
      const autoReview = !skipAutoReview && (workspace.requiresReview || prefMap.get("auto_review") !== "false");
      if (!autoReview) return;

      const reviewProvider = parseProviderPref(prefMap), reviewProfile = prefMap.get("claude_profile") || undefined;
      const agentCommand = isMockProfile(reviewProfile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const claudeProfile = isMockProfile(reviewProfile) ? undefined : reviewProfile;
      const effectiveReviewProfile = getEffectiveProfile(prefMap, reviewProvider, claudeProfile);
      const profileSelection = effectiveReviewProfile ? { provider: reviewProvider, name: effectiveReviewProfile } : undefined;
      const reviewArgs = buildReviewArgs(prefMap, reviewProvider), autoFix = workspace.isDirect ? false : prefMap.get("review_auto_fix") !== "false";
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
      } catch (err) { console.error("[workflow] Failed to launch review session:", err); }
    } catch (err) {
      console.error("[workflow] onSessionExit error:", err);
    }
  }
  return { runWorkflowOnExit, reviewSessionIds, fixAndMergeSessionIds, learningSessionIds };
}
