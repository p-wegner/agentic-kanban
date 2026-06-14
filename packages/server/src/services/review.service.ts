import { agentSkills, issues, preferences, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { PREF_CODEX_PROFILE, PREF_COPILOT_PROFILE } from "../constants/preference-keys.js";
import type { ProviderName } from "./agent-provider.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";
import * as gitService from "./git.service.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "./agent-settings.service.js";

export const DEFAULT_MONITOR_NUDGE_PROMPT =
  "Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.";

export const DEFAULT_REVIEW_PROMPT = `You are an AI code reviewer. Review the changes on branch '{{branch}}'.

First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`;

export function buildReviewArgs(prefMap: Map<string, string>, provider: ProviderName): string | undefined {
  const skipPerms = prefMap.get("skip_permissions") !== "false" && provider === "claude";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

export function parseProviderPref(prefMap: Map<string, string>): ProviderName {
  const provider = prefMap.get("provider");
  if (provider === "codex" || provider === "copilot") return provider;
  return "claude";
}

export function getEffectiveProfile(prefMap: Map<string, string>, provider: ProviderName, claudeProfile: string | undefined): string | undefined {
  if (provider === "codex") return prefMap.get(PREF_CODEX_PROFILE) || undefined;
  if (provider === "copilot") return prefMap.get(PREF_COPILOT_PROFILE) || undefined;
  return claudeProfile;
}

/**
 * Return a copy of `prefMap` with the provider + matching profile key overridden
 * from the workspace's recorded selection, so a review/continuation runs on the
 * SAME provider+profile the workspace was built with instead of silently falling
 * back to the global default. This is what keeps a per-workspace Codex OAuth license
 * (or any chosen profile) sticky across review — without it, getEffectiveProfile
 * reads the global `codex_profile`, which may differ (or have rotated). Leaves the
 * global default in place when the workspace recorded no provider/profile.
 */
export function applyWorkspaceProfileToPrefs(
  prefMap: Map<string, string>,
  workspace: { provider: string | null; claudeProfile: string | null },
): Map<string, string> {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return prefMap;
  const next = new Map(prefMap);
  next.set("provider", provider);
  const name = workspace.claudeProfile || undefined;
  if (name) {
    if (provider === "codex") next.set(PREF_CODEX_PROFILE, name);
    else if (provider === "copilot") next.set(PREF_COPILOT_PROFILE, name);
    else next.set("claude_profile", name);
  }
  return next;
}

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
): Promise<{ prompt: string; model: string | null }> {
  let template: string | null = null;
  let skillModel: string | null = null;
  if (projectId) {
    const projectSkill = await database.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    template = projectSkill[0]?.prompt ?? null;
    skillModel = projectSkill[0]?.model ?? null;
  }
  if (!template) {
    const globalSkill = await database.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND ${agentSkills.projectId} IS NULL`)
      .limit(1);
    template = globalSkill[0]?.prompt ?? DEFAULT_REVIEW_PROMPT;
    skillModel = globalSkill[0]?.model ?? null;
  }

  // When a workspaceId is available, signal approval via mark_ready_for_merge with the
  // literal id (NOT the {{workspaceId}} placeholder — if the id were ever empty the
  // placeholder collapses to "workspaceId=" and the agent has no actionable tool call).
  // When it is missing (e.g. direct/in-place review), fall back to the issue-status path
  // so the approval branch is always actionable.
  const approvalInstruction = workspaceId
    ? `1. Use the mark_ready_for_merge MCP tool with workspaceId=${workspaceId} to signal the workspace is approved
2. Exit normally (the scheduled merge orchestrator will merge it)`
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

  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173";

  let prompt = conflictPreamble + template
    .replace(/\{\{branch}}/g, branch)
    .replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD")
    .replace(/\{\{issueId}}/g, issueId)
    .replace(/\{\{workspaceId}}/g, workspaceId ?? "")
    .replace(/\{\{serverPort}}/g, serverPort)
    .replace(/\{\{clientPort}}/g, clientPort)
    .replace(/\{\{autoFixInstructions}}/g, autoFixInstructions);

  if (verifyAgent === "reviewer") {
    prompt += `

## Post-Review: Merge + Visual Verification Required

This project uses \`visual_verification_mode=after_merge\` with \`after_merge_verify_agent=reviewer\`.
**You are responsible for the complete pipeline**: approve code → merge workspace → visual verify on master.

After completing your code review and fixing any CRITICAL/MAJOR issues:

1. **Merge the workspace** (instead of mark_ready_for_merge, call merge directly):
   \`\`\`
   curl -s -X POST http://localhost:${serverPort}/api/workspaces/${workspaceId ?? "{{workspaceId}}"}/merge
   \`\`\`

2. **After merge, visually verify** the UI changes on master:
   - Use the playwright-cli skill (/playwright-cli) or run playwright directly
   - Navigate to http://localhost:${clientPort}
   - Check the relevant UI sections for the changed files on branch '${branch}'
   - Take a screenshot to confirm the UI renders correctly

3. **Report** your verification result.

The stop hook will remind you if you try to exit before completing all three steps.`;
  }

  return { prompt, model: skillModel };
}

export async function buildMonitorNudgePrompt(database: Database, projectId: string): Promise<string> {
  const skillRows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`
      ${agentSkills.name} = 'monitor-nudge'
      AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)
    `)
    .orderBy(sql`${agentSkills.projectId} IS NULL`)
    .limit(1);

  return skillRows[0]?.prompt?.trim() || DEFAULT_MONITOR_NUDGE_PROMPT;
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST",
    public readonly details?: { conflictFiles?: string[]; uncommittedChanges?: string[] },
  ) {
    super(message);
  }
}

/** In-flight review launches keyed by workspaceId — prevents duplicate sessions when
 *  concurrent requests both pass the idle-status check before either updates the DB. */
const pendingReviewLaunches = new Set<string>();

export async function startManualReview(
  database: Database,
  getSessionManager: () => SessionManager,
  boardEvents: BoardEvents,
  reviewSessionIds: Set<string>,
  workspaceId: string,
  thoroughReview: boolean,
): Promise<{ sessionId: string }> {
  const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (wsRows.length === 0) throw new ReviewError("Workspace not found", "NOT_FOUND");
  const workspace = wsRows[0];
  if (workspace.status !== "idle") {
    // Check if there's an active review session so we can give a more specific message
    const runningReview = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running"), eq(sessions.triggerType, "review")))
      .limit(1);
    if (runningReview.length > 0) {
      throw new ReviewError(`Review session ${runningReview[0].id} is already running for this workspace`, "CONFLICT");
    }
    throw new ReviewError("Workspace is not idle", "CONFLICT");
  }

  // Guard against concurrent requests that both passed the idle check before either
  // updates the DB status to "reviewing".
  if (pendingReviewLaunches.has(workspaceId)) {
    throw new ReviewError("Review launch already in progress for this workspace", "CONFLICT");
  }
  pendingReviewLaunches.add(workspaceId);

  try {
    const issueRows = await database.select({ projectId: issues.projectId, id: issues.id }).from(issues).where(eq(issues.id, workspace.issueId)).limit(1);
    if (issueRows.length === 0) throw new ReviewError("Issue not found", "NOT_FOUND");
    const { projectId, id: issueId } = issueRows[0];

    const prefRows = await database.select().from(preferences);
    // Review on the same provider/profile the workspace was built with (e.g. its
    // Codex OAuth license), not the global default which may have rotated since.
    const prefMap = applyWorkspaceProfileToPrefs(new Map(prefRows.map((r) => [r.key, r.value])), workspace);
    const manualProfile = prefMap.get("claude_profile") || undefined;
    const agentCommand = isMockProfile(manualProfile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
    const claudeProfile = isMockProfile(manualProfile) ? undefined : manualProfile;
    const provider = parseProviderPref(prefMap);
    const effectiveProfileName = getEffectiveProfile(prefMap, provider, claudeProfile);
    const manualProfileSelection = effectiveProfileName ? { provider, name: effectiveProfileName } : undefined;
    const reviewArgs = buildReviewArgs(prefMap, provider);
    const autoFix = prefMap.get("review_auto_fix") !== "false";

    const projectRows = await database.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;
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
    const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(
      database, workspace.branch, diffRef, issueId, autoFix, projectId,
      undefined, undefined, workspaceId, manualSkillName, verifyAgent,
    );
    const reviewArgsWithModel = reviewModel && provider === "claude" ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

    const now = new Date().toISOString();
    await database.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
    boardEvents.broadcast(projectId, "issue_updated");

    let sessionId: string;
    try {
      const reviewExtraEnv: Record<string, string> = { KANBAN_SESSION_TYPE: "review", KANBAN_AFTER_MERGE_VERIFY: verifyAgent };
      sessionId = await getSessionManager().startSession({
        workspaceId, prompt: reviewPromptText, agentCommand, agentArgs: reviewArgsWithModel,
        claudeProfile, profile: manualProfileSelection, provider: toExecutorProvider(provider),
        triggerType: "review", extraEnv: reviewExtraEnv,
      });
    } catch (sessionErr) {
      // Revert the workspace status so retries are possible — don't leave it stuck at "reviewing"
      const revertedAt = new Date().toISOString();
      await database.update(workspaces).set({ status: "idle", updatedAt: revertedAt }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcast(projectId, "issue_updated");
      throw sessionErr;
    }
    reviewSessionIds.add(sessionId);
    console.log(`[review-service] manual review session ${sessionId} for workspace ${workspaceId}`);
    return { sessionId };
  } finally {
    pendingReviewLaunches.delete(workspaceId);
  }
}
