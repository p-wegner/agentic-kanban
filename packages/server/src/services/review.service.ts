import { readSessionStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import type { Database } from "../db/index.js";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import {
  getProjectScopedReviewSkill,
  getGlobalReviewSkill,
  getMonitorNudgeSkill,
  getWorkspaceById,
  getRunningReviewSession,
  getRunningWorkspaceSession,
  getLatestWorkspaceSession,
  getIssueProjectAndId,
  getAllPreferenceRows,
  getProjectDefaultBranch,
} from "../repositories/review.repository.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import type { BoardEventSink } from "./board-events.js";
import type { SessionLauncher } from "./session.manager.js";
import * as gitService from "./git.service.js";
import { applyWorkspaceProfileToPrefs, resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { buildReviewContext } from "./phase-context.service.js";
import { resolveBoardServerPort } from "@agentic-kanban/shared/lib/board-server-url";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
export const DEFAULT_MONITOR_NUDGE_PROMPT =
  "Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.";

export const DEFAULT_REVIEW_PROMPT = `You are an AI code reviewer. Review the changes on branch '{{branch}}'.

{{precomputedContext}}

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`;

/**
 * What `{{precomputedContext}}` collapses to when the board could NOT pre-compute a
 * diff (no worktree, git failure, direct workspace with no base). The agent then
 * discovers the change itself — the pre-#128 behaviour.
 */
export const REVIEW_CONTEXT_FALLBACK = `First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.`;

export async function buildReviewPrompt(
  database: Database,
  branch: string,
  baseBranch: string | null,
  issueId: string,
  autoFix: boolean,
  projectId?: string,
  conflictingFiles?: string[],
  uncommittedChanges?: string[],
  workspaceId?: string,
  skillName = "code-review",
  verifyAgent?: string,
  precomputedContext?: string | null,
): Promise<{ prompt: string; model: string | null }> {
  let template: string | null = null;
  let skillModel: string | null = null;
  if (projectId) {
    const projectSkill = await getProjectScopedReviewSkill(skillName, projectId, database);
    template = projectSkill?.prompt ?? null;
    skillModel = projectSkill?.model ?? null;
  }
  if (!template) {
    const globalSkill = await getGlobalReviewSkill(skillName, database);
    template = globalSkill?.prompt ?? DEFAULT_REVIEW_PROMPT;
    skillModel = globalSkill?.model ?? null;
  }

  // Approval signalling (#466).
  //
  // For a WORKSPACE review the reviewer must NOT be told to call `mark_ready_for_merge`: the
  // board sets `readyForMerge` itself in `handleReviewSessionExit`, and only after its own
  // pre-merge gate (verify + smoke) passes. The tool call was therefore redundant — the board
  // ignores it and re-decides — but not harmless: when the tool was unreachable the reviewer
  // ended a CLEAN review with "Blocked: mark_ready_for_merge is not available", which reads as
  // "the review could not approve this" and sends the reader hunting an MCP fault. The actual
  // reason such a workspace sits unapproved is almost always that the gate FAILED, which the
  // board logs and emits a butler event for. One misleading sentence cost a real
  // misdiagnosis; the reviewer's job is to judge the code and report, not to flip a flag whose
  // owner is the exit workflow.
  //
  // Without a workspaceId (direct/in-place review) there IS no exit-workflow gate to set the
  // flag, so that branch keeps its issue-status signal — it is the only thing recording approval.
  const approvalInstruction = workspaceId
    ? `1. State clearly that the review found no CRITICAL or MAJOR issues
2. Exit normally

Do NOT mark the workspace ready for merge yourself, and do not call a tool to do it. The board
runs its own pre-merge gate (verify + smoke) when you exit and marks readiness only if that
passes — so approval is not yours to signal, and a missing tool is never what blocks it.`
    : `1. Use the move_issue MCP tool to move issue ${issueId} to 'AI Reviewed' to signal approval
2. Exit normally (the scheduled merge orchestrator will merge it)`;

  const autoFixInstructions = autoFix
    ? `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress' (so the board shows the issue needs fixes)
2. Fix all critical and major issues directly in the code
3. Commit the fixes with a descriptive message
4. Exit normally (the system will handle merging)

If only MINOR issues or no issues:
${approvalInstruction}`
    : `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress'
2. Describe each issue clearly so the developer knows what to fix
3. Do NOT edit any files — report only

If only MINOR issues or no issues:
${approvalInstruction}`;

  const localBaseBranch = (baseBranch ?? "HEAD").replace(/^origin\//, "");

  let conflictPreamble = "";
  if (uncommittedChanges && uncommittedChanges.length > 0) {
    conflictPreamble = `IMPORTANT: The worktree has uncommitted changes. You must commit or stash them before rebasing and reviewing.

Uncommitted files (git status --porcelain):
${uncommittedChanges.map(f => `  ${f}`).join("\n")}

Steps to resolve:
1. Review the changes: git diff (for unstaged), git diff --cached (for staged)
2. If the changes belong to this branch: git add -A && git commit -m "WIP: uncommitted changes"
3. Then rebase: git rebase origin/${localBaseBranch} (or git rebase ${localBaseBranch} if no remote)
4. Once the working tree is clean and rebased, proceed with the code review below.

---

`;
  } else if (conflictingFiles && conflictingFiles.length > 0) {
    conflictPreamble = `IMPORTANT: Auto-rebase onto the base branch failed due to conflicts. The rebase has been aborted, so the worktree is clean. You must resolve the conflicts and rebase manually before reviewing.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}

Steps to resolve:
1. Start a fresh rebase: git rebase origin/${localBaseBranch}
   (or use the local branch if no remote: git rebase ${localBaseBranch})
2. For each conflicting file, open it and resolve the conflict markers (<<<<<<<, =======, >>>>>>>)
3. After resolving each file: git add <resolved-file>
4. Continue: git rebase --continue (repeat for each conflicting commit)
5. Once the rebase completes, proceed with the code review below.

---

`;
  }

  const serverPort = String(resolveBoardServerPort());
  const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173";
  const visualProofAttachTarget = workspaceId
    ? `\`workspaceId: "${workspaceId}"\``
    : `\`issueId: "${issueId}"\``;

  // A project-scoped skill may not carry the {{precomputedContext}} placeholder. Rather
  // than force every custom template to be rewritten, prepend the block in that case so
  // the reviewer still gets the diff instead of cold-rebuilding it (#128).
  const contextBlock = precomputedContext?.trim() || REVIEW_CONTEXT_FALLBACK;
  const hasContextPlaceholder = /\{\{precomputedContext}}/.test(template);
  const contextPrefix = hasContextPlaceholder || !precomputedContext?.trim()
    ? ""
    : `${precomputedContext.trim()}\n\n---\n\n`;

  // The context block is substituted LAST and its own text is never re-scanned:
  // a diff can legitimately contain literal `{{baseBranch}}`-style text (this file
  // does), and expanding placeholders inside reviewed source would corrupt it.
  const rendered = template
    .replace(/\{\{branch}}/g, branch)
    .replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD")
    .replace(/\{\{issueId}}/g, issueId)
    .replace(/\{\{workspaceId}}/g, workspaceId ?? "")
    .replace(/\{\{serverPort}}/g, serverPort)
    .replace(/\{\{clientPort}}/g, clientPort)
    .replace(/\{\{autoFixInstructions}}/g, autoFixInstructions);
  // Only the fallback text carries a placeholder; a real diff must be passed through verbatim.
  const renderedContext = precomputedContext?.trim()
    ? contextBlock
    : contextBlock.replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD");

  let prompt = conflictPreamble + contextPrefix + rendered
    .replace(/\{\{precomputedContext}}/g, () => renderedContext);

  if (verifyAgent === "reviewer") {
    prompt += `

## Post-Review: Visual Verification Required (before approval)

This project uses \`visual_verification_mode=after_merge\` with \`after_merge_verify_agent=reviewer\`.
**You are responsible for visually verifying the UI before approving** — but do NOT merge the
workspace yourself. The system runs the project's verify_script + smoke gate on your review
exit and only then merges; merging by hand would skip that gate.

After completing your code review and fixing any CRITICAL/MAJOR issues:

1. **Visually verify** the UI changes on this branch's worktree:
   - Use the playwright-cli skill (/playwright-cli) or run playwright directly
   - Navigate to http://localhost:${clientPort}
   - Check the relevant UI sections for the changed files on branch '${branch}'
   - Capture a short WebM proof recording and take a screenshot to confirm the UI renders correctly
   - Write ANY screenshots, log files, or scratch output into a \`.verify/\` directory (it is
     gitignored) — never the repo root. Don't leave \`*.log\`, \`*.png\`, or \`*.webm\` artifacts in the checkout.
   - Attach the WebM recording with \`attach_artifact\` using \`type: "video"\`,
     \`mimeType: "video/webm"\`, ${visualProofAttachTarget}, and a visual-proof caption.

2. **Report** your verification result.

3. **Signal approval** exactly as instructed above (report the verdict / move to 'AI Reviewed')
   and exit normally. Do NOT call the merge endpoint yourself — the verify_script + smoke gate
   runs on your exit and the system merges once it passes.

The stop hook will remind you if you try to exit before verifying the UI.`;
  }

  return { prompt, model: skillModel };
}

export async function buildMonitorNudgePrompt(database: Database, projectId: string): Promise<string> {
  const skill = await getMonitorNudgeSkill(projectId, database);
  return skill?.prompt?.trim() || DEFAULT_MONITOR_NUDGE_PROMPT;
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST",
    public readonly details?: {
      conflictFiles?: string[];
      uncommittedChanges?: string[];
      workspaceStatus?: string;
      retryable?: boolean;
      reason?: string;
      activeSessionId?: string;
      activeTriggerType?: string | null;
      latestSessionId?: string;
      latestTriggerType?: string | null;
    },
  ) {
    super(message);
  }
}

/** In-flight review launches keyed by workspaceId — prevents duplicate sessions when
 *  concurrent requests both pass the idle-status check before either updates the DB. */
const pendingReviewLaunches = new Set<string>();

/**
 * Cross-path review-launch reservation (#270). The Set above only guarded concurrent
 * `startManualReview` calls; the exit-workflow's auto-review launches sessions directly and
 * raced the stranded-review reconciler into TWO review sessions for one workspace within the
 * same second (the zombie-fixer then killed one and reset the workspace mid-merge). Every
 * code path that launches a review session must reserve here first and release when done.
 */
export function tryReserveReviewLaunch(workspaceId: string): boolean {
  if (pendingReviewLaunches.has(workspaceId)) return false;
  pendingReviewLaunches.add(workspaceId);
  return true;
}

export function releaseReviewLaunch(workspaceId: string): void {
  pendingReviewLaunches.delete(workspaceId);
}

/** True while any path (manual, auto-review, reconciler) is mid-launch for this workspace. */
export function isReviewLaunchPending(workspaceId: string): boolean {
  return pendingReviewLaunches.has(workspaceId);
}

function isUsageLimitLaunchFailureStats(stats: string | null): boolean {
  if (!stats) return false;
  try {
    const parsed = readSessionStats(stats);
    if (parsed.rateLimited === true && (parsed.rateLimitKind === "codex-usage-limit" || parsed.rateLimitKind === "claude-usage-limit")) {
      return true;
    }
    const reason = typeof parsed.failureReason === "string" ? parsed.failureReason : "";
    return parsed.launchFailure === true && /usage limit/i.test(reason);
  } catch {
    return false;
  }
}

async function classifyBlockedReviewRecovery(
  workspaceId: string,
  database: Database,
): Promise<
  | { retryable: true; latestSessionId: string }
  | { retryable: false; message: string; details: NonNullable<ReviewError["details"]> }
> {
  const running = await getRunningWorkspaceSession(workspaceId, database);
  if (running.length > 0) {
    return {
      retryable: false,
      message: `Workspace is blocked but session ${running[0].id} is still running`,
      details: {
        workspaceStatus: "blocked",
        retryable: false,
        reason: "active_session",
        activeSessionId: running[0].id,
        activeTriggerType: running[0].triggerType,
      },
    };
  }

  const latestRows = await getLatestWorkspaceSession(workspaceId, database);
  const latest = latestRows[0];
  if (!latest) {
    return {
      retryable: false,
      message: "Workspace is blocked and has no prior session to recover",
      details: { workspaceStatus: "blocked", retryable: false, reason: "missing_session" },
    };
  }
  if (latest.triggerType !== "review") {
    return {
      retryable: false,
      message: "Workspace is blocked but the latest session is not a review launch",
      details: {
        workspaceStatus: "blocked",
        retryable: false,
        reason: "latest_session_not_review",
        latestSessionId: latest.id,
        latestTriggerType: latest.triggerType,
      },
    };
  }
  if (latest.status !== "stopped" || !latest.endedAt || !isUsageLimitLaunchFailureStats(latest.stats)) {
    return {
      retryable: false,
      message: "Workspace is blocked and the latest review failure is not retryable",
      details: {
        workspaceStatus: "blocked",
        retryable: false,
        reason: "not_retryable",
        latestSessionId: latest.id,
        latestTriggerType: latest.triggerType,
      },
    };
  }

  return { retryable: true, latestSessionId: latest.id };
}

export async function startManualReview(
  database: Database,
  getSessionManager: () => SessionLauncher,
  boardEvents: BoardEventSink,
  reviewSessionIds: Set<string>,
  workspaceId: string,
  thoroughReview: boolean,
): Promise<{ sessionId: string }> {
  const workspace = await getWorkspaceById(workspaceId, database);
  if (!workspace) throw new ReviewError("Workspace not found", "NOT_FOUND");
  let recoverBlockedReview = false;
  if (workspace.status !== "idle") {
    if (workspace.status === "blocked") {
      const recovery = await classifyBlockedReviewRecovery(workspaceId, database);
      if (recovery.retryable) {
        recoverBlockedReview = true;
      } else {
        throw new ReviewError(recovery.message, "CONFLICT", recovery.details);
      }
    } else {
      // Check if there's an active review session so we can give a more specific message
      const runningReview = await getRunningReviewSession(workspaceId, database);
      if (runningReview.length > 0) {
        throw new ReviewError(`Review session ${runningReview[0].id} is already running for this workspace`, "CONFLICT", {
          workspaceStatus: workspace.status,
          retryable: false,
          reason: "active_review_session",
          activeSessionId: runningReview[0].id,
          activeTriggerType: "review",
        });
      }
      throw new ReviewError("Workspace is not idle", "CONFLICT", {
        workspaceStatus: workspace.status,
        retryable: false,
        reason: "workspace_not_idle",
      });
    }
  }

  // Guard against concurrent requests that both passed the idle check before either
  // updates the DB status to "reviewing".
  if (!tryReserveReviewLaunch(workspaceId)) {
    throw new ReviewError("Review launch already in progress for this workspace", "CONFLICT");
  }

  try {
    const issueRows = await getIssueProjectAndId(workspace.issueId, database);
    if (issueRows.length === 0) throw new ReviewError("Issue not found", "NOT_FOUND");
    const { projectId, id: issueId } = issueRows[0];

    const prefRows = await getAllPreferenceRows(database);
    // Review on the same provider/profile the workspace was built with (e.g. its
    // Codex OAuth license), not the global default which may have rotated since.
    // Exception: a blocked usage-limit review recovery intentionally uses the current
    // board default so switching providers can recover a stale provider/profile.
    const defaultPrefMap = toPrefMap(prefRows);
    const prefMap = recoverBlockedReview ? defaultPrefMap : applyWorkspaceProfileToPrefs(defaultPrefMap, workspace);
    const runtime = recoverBlockedReview
      ? await loadProjectRuntimeConfig(database, { projectId })
      : null;
    // #541: the fifth copy of the prefs -> {command, args, provider, profile} ladder.
    // `prefMap` is already workspace-pinned above (except on the recover path, which takes
    // its values from `runtime` instead), so plain resolveAgentSettings is the right call.
    const settings = resolveAgentSettings(prefMap);
    const provider = runtime?.provider.provider ?? settings.provider;
    const agentCommand = runtime?.provider.agentCommand ?? settings.agentCommand;
    const manualProfileSelection = runtime?.provider.profileSelection ?? settings.profile;
    const reviewArgs = runtime?.provider.agentArgs ?? settings.agentArgs;
    const autoFix = getBool(prefMap, "review_auto_fix");

    const defaultBranch = (await getProjectDefaultBranch(projectId, database))?.defaultBranch ?? null;
    let diffRef = workspace.baseBranch || defaultBranch;

    if (!workspace.isDirect && workspace.workingDir) {
      const baseBranch = workspace.baseBranch || defaultBranch;
      if (!baseBranch) throw new ReviewError("No default branch configured for this project. Set a default branch in project settings before reviewing.", "BAD_REQUEST");
      const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
      if (!prep.success) {
        console.warn(`[review-service] rebase failed for manual review ${workspaceId}: ${prep.error}`);
        // Return a structured 409 so the caller (UI/monitor) can route to fix-and-merge
        // instead of launching a review session that can't proceed.
        const files = prep.conflictingFiles ?? [];
        const uncommitted = prep.uncommittedChanges ?? [];
        const summary = files.length > 0
          ? `Rebase conflict during review preflight: ${files.length} file(s) conflict. Route to fix-and-merge to resolve.`
          : `Rebase failed during review preflight: ${prep.error ?? "unknown error"}`;
        throw new ReviewError(summary, "CONFLICT", {
          conflictFiles: files,
          uncommittedChanges: uncommitted,
        });
      }
      diffRef = prep.diffRef;
    }

    const manualSkillName = thoroughReview ? "code-review-thorough" : "code-review";
    const verifyAgent = prefMap.get("after_merge_verify_agent") || "none";
    // Same pre-computed context the auto-review path gets (#128) — a manual review is
    // just as cold a start. Reaching here means the rebase preflight succeeded.
    const manualContext = workspace.workingDir && diffRef
      ? await buildReviewContext({ workingDir: workspace.workingDir, baseRef: diffRef, isDirect: workspace.isDirect })
      : null;
    const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(
      database, workspace.branch, diffRef, issueId, autoFix, projectId,
      undefined, undefined, workspaceId, manualSkillName, verifyAgent, manualContext,
    );
    const runtimeModel = runtime?.provider.model;
    const reviewArgsWithModel = reviewModel && provider === "claude" ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

    const now = new Date().toISOString();
    await setWorkspaceStatus(database, workspaceId, "reviewing", { now });
    boardEvents.broadcast(projectId, "issue_updated");

    let sessionId: string;
    try {
      const reviewExtraEnv: Record<string, string> = { KANBAN_SESSION_TYPE: "review", KANBAN_AFTER_MERGE_VERIFY: verifyAgent };
      sessionId = await getSessionManager().startSession({
        workspaceId, prompt: reviewPromptText, agentCommand, agentArgs: reviewArgsWithModel,
        profile: manualProfileSelection, provider: toExecutorProvider(provider),
        triggerType: "review", extraEnv: reviewExtraEnv,
        permissionPromptTool: runtime?.provider.permissionPromptTool,
        resumeWithNewModel: runtime?.provider.resumeWithNewModel,
        model: runtimeModel,
      });
    } catch (sessionErr) {
      // Revert the workspace status so retries are possible — don't leave it stuck at "reviewing".
      // Goes through the terminal-invariant authority: if a concurrent merge landed
      // closed+mergedAt in the meantime, this revive is a logged no-op (#985).
      const revertedAt = new Date().toISOString();
      await setWorkspaceStatus(database, workspaceId, "idle", { now: revertedAt });
      boardEvents.broadcast(projectId, "issue_updated");
      throw sessionErr;
    }
    reviewSessionIds.add(sessionId);
    console.log(`[review-service] manual review session ${sessionId} for workspace ${workspaceId}`);
    return { sessionId };
  } finally {
    releaseReviewLaunch(workspaceId);
  }
}
