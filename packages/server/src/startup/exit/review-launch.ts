/**
 * Launching the auto-review session (#700 extraction).
 *
 * ONE responsibility: given a builder workspace that produced committed changes, START a review
 * session on it. That is a self-contained protocol with its own collaborators — the cross-path
 * launch reservation (#270), the provider/profile ladder (#541), the pre-review rebase, the
 * precomputed diff context (#128), the prompt builder, and the #529 stranding recovery on launch
 * failure — and none of them appear anywhere else in the exit workflow.
 *
 * What is deliberately NOT here: the DECISION to review. Whether a workspace should be reviewed
 * at all (skipAutoReview, the workflow-node guards, the fork-child guard, the pref) belongs to
 * the builder-exit handler, which owns that policy. This module is asked, not consulted — which
 * is why the reservation, the recovery and the prompt assembly can be read without the policy
 * around them, and why the policy can be read without 70 lines of launch mechanics inside it.
 *
 * No `db` singleton and no raw drizzle: the connection is injected and the only write goes
 * through `setWorkspaceStatus`.
 */
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { setWorkspaceStatus } from "../../repositories/workspace-status.repository.js";
import { applyWorkspaceProfileToPrefs, resolveWorkspaceLaunchSettings, toExecutorProvider } from "../../services/agent-settings.service.js";
import { emitButlerSystemEvent } from "../../services/butler-event-feed.js";
import { buildReviewContext } from "../../services/phase-context.service.js";
import { buildReviewPrompt, releaseReviewLaunch, tryReserveReviewLaunch } from "../../services/review.service.js";
import type { Database } from "../../db/index.js";
import type { createBoardEvents } from "../../services/board-events.js";
import type { createSessionManager } from "../../services/session.manager.js";
import type { GitService } from "../../services/workspace-internals.js";
import type { ExitContext } from "./exit-context.js";

export interface ReviewLaunchDeps {
  database: Database;
  gitService: GitService;
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  /** The engine's live set of review-session ids, so the dispatcher recognises the review's own exit. */
  reviewSessionIds: Set<string>;
}

export function createReviewLauncher({ database: db, gitService, sessionManager, boardEvents, reviewSessionIds }: ReviewLaunchDeps) {
  async function launchAutoReviewReserved(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, issueId, now, prefMap, defaultBranch } = ctx;
    const workspaceId = workspace.id;
    // Review on the same provider/profile the workspace was built with (e.g. its
    // Codex OAuth license), not the global default which may have rotated since.
    // #541: same ladder as the learning step, spelled differently. Now one call.
    const reviewPrefs = applyWorkspaceProfileToPrefs(prefMap, workspace);
    const { agentCommand, agentArgs: reviewArgs, provider: reviewProvider, profile: profileSelection } =
      resolveWorkspaceLaunchSettings(prefMap, workspace);
    const autoFix = workspace.isDirect ? false : getBool(reviewPrefs, "review_auto_fix");
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
    // Hand the reviewer the diff instead of making a cold agent rediscover it (#128).
    // Skipped when the rebase failed — the tree is mid-conflict, so a diff taken now
    // would describe a state the reviewer is about to change.
    const precomputedContext = workspace.workingDir && diffRef && !conflictingFiles && !uncommittedChanges
      ? await buildReviewContext({ workingDir: workspace.workingDir, baseRef: diffRef, isDirect: workspace.isDirect })
      : null;
    const { prompt, model } = await buildReviewPrompt(db, workspace.branch, diffRef, issueId, autoFix, projectId, conflictingFiles, uncommittedChanges, workspaceId, reviewSkillName, verifyAgent, precomputedContext);
    const reviewArgsWithModel = model && reviewProvider === "claude" ? `${reviewArgs ?? ""} --model ${model}`.trim() : reviewArgs;
    try {
      await setWorkspaceStatus(db, workspaceId, "reviewing", { now });
      boardEvents.broadcast(projectId, "issue_updated");
      const reviewSessionId = await sessionManager.startSession({ workspaceId, prompt, agentCommand, agentArgs: reviewArgsWithModel, provider: toExecutorProvider(reviewProvider), triggerType: "review", profile: profileSelection, extraEnv: { KANBAN_SESSION_TYPE: "review", KANBAN_AFTER_MERGE_VERIFY: verifyAgent } });
      reviewSessionIds.add(reviewSessionId);
      console.log(`[workflow] launched ${reviewSkillName} session ${reviewSessionId} for workspace ${workspaceId} (verifyAgent=${verifyAgent})`);
    } catch (err) {
      console.error("[workflow] Failed to launch review session:", err);
      // Do NOT swallow this and leave the workspace stuck at "reviewing" with no
      // running session (the #529 stranding). Reset to idle and surface the failure;
      // the stranded-review reconciler then re-launches it instead of it sitting
      // forever as never-reviewed / not-mergeable.
      await setWorkspaceStatus(db, workspaceId, "idle");
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({ projectId, kind: "session_failed", workspaceId, text: `Auto-review failed to launch for workspace ${workspaceId}; reset to idle for recovery.` });
    }
  }

  /**
   * Launch the auto-review session for a builder that produced committed changes.
   * Runs on the same provider/profile the workspace was built with; on launch
   * failure resets the workspace to idle so the stranded-review reconciler can
   * recover it (#529) rather than leaving it stuck at "reviewing".
   */
  async function launchAutoReview(ctx: ExitContext): Promise<void> {
    const workspaceId = ctx.workspace.id;
    // Cross-path launch reservation (#270): the stranded-review reconciler and manual review
    // share this slot, so two paths deciding "this workspace needs a review" in the same
    // second can no longer both spawn a session.
    if (!tryReserveReviewLaunch(workspaceId)) {
      console.log(`[workflow] review launch already in progress for workspace ${workspaceId} — skipping duplicate auto-review`);
      return;
    }
    try {
      await launchAutoReviewReserved(ctx);
    } finally {
      releaseReviewLaunch(workspaceId);
    }
  }

  return { launchAutoReview };
}
