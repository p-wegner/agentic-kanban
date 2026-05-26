import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { createRoutes } from "./routes/index.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db, rawClient } from "./db/index.js";
import { createSessionManager } from "./services/session.manager.js";
import type { ProviderName } from "./services/agent-provider.js";
import { createBoardEvents } from "./services/board-events.js";
import { workspaces, issues, projects, projectStatuses, preferences, sessions, sessionMessages, agentSkills, issueDependencies, scheduledRuns, tags, issueTags } from "@agentic-kanban/shared/schema";
import { getNextCronRun } from "@agentic-kanban/shared/lib/cron-utils";
import { eq, sql, desc } from "drizzle-orm";
import * as agentService from "./services/agent.service.js";
import * as gitService from "./services/git.service.js";
import { killProcessesInDir } from "./services/process-cleanup.js";
import { runScript } from "./services/script-runner.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { getMigrationsFolder } from "./db/migrations.js";
import { applyMigrations } from "./db/manual-migrate.js";
import { deduplicateProjects } from "./services/project-registration.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "./services/agent-settings.service.js";
import { PREF_CODEX_PROFILE, PREF_COPILOT_PROFILE } from "./constants/preference-keys.js";
import { sendMonitorNudge, type MonitorActionName } from "./services/monitor-nudge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const DEFAULT_MONITOR_NUDGE_PROMPT =
  "Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.";

const DEFAULT_REVIEW_PROMPT = `You are an AI code reviewer. Review the changes on branch '{{branch}}'.

First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`;

function buildReviewArgs(prefMap: Map<string, string>, provider: ProviderName): string | undefined {
  // `--dangerously-skip-permissions` is Claude-only; other providers use native
  // permission flags and abort on Claude-specific arguments.
  const skipPerms = prefMap.get("skip_permissions") === "true" && provider === "claude";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

function parseProviderPref(prefMap: Map<string, string>): ProviderName {
  const provider = prefMap.get("provider");
  if (provider === "codex" || provider === "copilot") return provider;
  return "claude";
}

function getEffectiveProfile(prefMap: Map<string, string>, provider: ProviderName, claudeProfile: string | undefined): string | undefined {
  if (provider === "codex") return prefMap.get(PREF_CODEX_PROFILE) || undefined;
  if (provider === "copilot") return prefMap.get(PREF_COPILOT_PROFILE) || undefined;
  return claudeProfile;
}

async function buildReviewPrompt(branch: string, baseBranch: string | null, issueId: string, autoFix: boolean, projectId?: string, conflictingFiles?: string[], uncommittedChanges?: string[], workspaceId?: string, skillName = "code-review", verifyAgent?: string): Promise<{ prompt: string; model: string | null }> {
  let template: string | null = null;
  let skillModel: string | null = null;
  if (projectId) {
    const projectSkill = await db.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    template = projectSkill[0]?.prompt ?? null;
    skillModel = projectSkill[0]?.model ?? null;
  }
  if (!template) {
    // Fall back to global skill by name, then DEFAULT_REVIEW_PROMPT
    const globalSkill = await db.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND ${agentSkills.projectId} IS NULL`)
      .limit(1);
    template = globalSkill[0]?.prompt ?? DEFAULT_REVIEW_PROMPT;
    skillModel = globalSkill[0]?.model ?? null;
  }

  const autoFixInstructions = autoFix
    ? `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress' (so the board shows the issue needs fixes)
2. Fix all critical and major issues directly in the code
3. Commit the fixes with a descriptive message
4. Exit normally (the system will handle merging)

If only MINOR issues or no issues:
1. Use the mark_ready_for_merge MCP tool with workspaceId={{workspaceId}} to signal the workspace is approved
2. Exit normally (the system will auto-merge)`
    : `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress'
2. Describe each issue clearly so the developer knows what to fix
3. Do NOT edit any files — report only

If only MINOR issues or no issues:
1. Use the mark_ready_for_merge MCP tool with workspaceId={{workspaceId}} to signal the workspace is approved
2. Exit normally (the system will auto-merge)`;

  // Strip "origin/" prefix so rebase instructions use the bare branch name.
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

async function buildMonitorNudgePrompt(projectId: string): Promise<string> {
  const skillRows = await db
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

export async function startServer(port?: number, hostname?: string) {
  const app = new Hono();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents(upgradeWebSocket);
  const reviewSessionIds = new Set<string>();
  const fixAndMergeSessionIds = new Set<string>();
  const learningSessionIds = new Set<string>();

  async function runWorkflowOnExit(workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) {
    try {
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (wsRows.length === 0) return;
      const workspace = wsRows[0];

      const issueRows = await db
        .select({ projectId: issues.projectId, id: issues.id, skipAutoReview: issues.skipAutoReview })
        .from(issues)
        .where(eq(issues.id, workspace.issueId))
        .limit(1);
      if (issueRows.length === 0) return;
      const { projectId, id: issueId, skipAutoReview } = issueRows[0];

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      // Clear live activity/stats on the client before broadcasting board_changed
      boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity: "" });
      boardEvents.broadcast(projectId, "session_completed");
      boardEvents.broadcast(projectId, "workspace_idle");

      // A read-only plan run produces no new commits, but the branch may already differ from
      // its base — which would otherwise trip the "committed changes → In Review → auto-review"
      // path below. The plan→implement continuation is handled in session.manager, so skip the
      // normal review/merge workflow here for plan-mode sessions.
      if (wasPlanMode) {
        console.log(`[workflow] plan-mode session ${sessionId} completed — skipping review/merge workflow`);
        return;
      }

      // Update scheduled run status if this workspace was launched by one
      try {
        const runRows = await db.select({ id: scheduledRuns.id }).from(scheduledRuns)
          .where(eq(scheduledRuns.lastRunWorkspaceId, workspaceId)).limit(1);
        if (runRows.length > 0) {
          const finalStatus = exitCode === 0 ? "success" : "error";
          await db.update(scheduledRuns).set({ lastRunStatus: finalStatus, updatedAt: now })
            .where(eq(scheduledRuns.id, runRows[0].id));
        }
      } catch (err) {
        console.warn("[workflow] failed to update scheduled run status:", err);
      }

      const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      const findStatus = (name: string) => statuses.find(s => s.name === name);

      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const autoMergeEnabled = prefMap.get("auto_merge") !== "false";

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;

      if (fixAndMergeSessionIds.has(sessionId)) {
        fixAndMergeSessionIds.delete(sessionId);
        if (exitCode === 0) {
          console.log(`[workflow] fix-and-merge session ${sessionId} completed — retrying merge`);
          await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
        } else {
          console.log(`[workflow] fix-and-merge session ${sessionId} exited with code ${exitCode} — not retrying merge`);
          boardEvents.broadcast(projectId, "workflow_error");
        }
        return;
      }

      if (learningSessionIds.has(sessionId)) {
        learningSessionIds.delete(sessionId);
        console.log(`[workflow] learning step session ${sessionId} completed — no further workflow action`);
        return;
      }

      if (exitCode !== 0) return;

      if (reviewSessionIds.has(sessionId)) {
        reviewSessionIds.delete(sessionId);

        const currentIssueRows = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
        const currentStatus = currentIssueRows.length > 0 ? statuses.find(s => s.id === currentIssueRows[0].statusId) : null;
        const autoFix = prefMap.get("review_auto_fix") !== "false";

        // Reviewer moved issue to "In Progress" to signal critical issues found
        if (currentStatus?.name === "In Progress" && !autoFix) {
          console.log(`[workflow] reviewer flagged issues (non-auto-fix mode) — skipping auto-merge, leaving in In Progress`);
          boardEvents.broadcast(projectId, "issue_updated");
          return;
        }

        // Optional learning step after review (runs in parallel with merge)
        let learningAfterReviewPromise: Promise<void> = Promise.resolve();
        if (prefMap.get("learning_step_after_review") === "true" && workspace.workingDir) {
          try {
            const providerLearn = parseProviderPref(prefMap);
            const profileLearn = prefMap.get("claude_profile") || undefined;
            const agentCmdLearn = isMockProfile(profileLearn) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
            const agentArgsLearn = prefMap.get("agent_args") || undefined;
            const claudeProfileLearn = isMockProfile(profileLearn) ? undefined : profileLearn;
            const effectiveProfileLearn = getEffectiveProfile(prefMap, providerLearn, claudeProfileLearn);
            const profileSelectionLearn = effectiveProfileLearn ? { provider: providerLearn, name: effectiveProfileLearn } : undefined;
            const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks.`;
            const learnSessId = await sessionManager.startSession({ workspaceId: workspace.id, prompt: learningPrompt, agentCommand: agentCmdLearn, agentArgs: agentArgsLearn, claudeProfile: effectiveProfileLearn, provider: toExecutorProvider(providerLearn), triggerType: "learning", profile: profileSelectionLearn });
            learningSessionIds.add(learnSessId);
            console.log(`[workflow] learning step (after review) started: session=${learnSessId}`);
            learningAfterReviewPromise = new Promise<void>((resolve) => {
              const timeout = setTimeout(() => { console.log("[workflow] learning step (after review) timed out after 3m"); resolve(); }, 3 * 60 * 1000);
              const poll = setInterval(async () => {
                const sessRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learnSessId)).limit(1);
                if (sessRows.length > 0 && sessRows[0].status !== "running") { clearInterval(poll); clearTimeout(timeout); console.log(`[workflow] learning step (after review) finished`); resolve(); }
              }, 5000);
            });
          } catch (err) {
            console.warn("[workflow] learning step (after review) failed (non-fatal):", err);
          }
        }

        if (autoMergeEnabled) {
          console.log(`[workflow] review session ${sessionId} completed — auto-merging (learning step runs in parallel)`);
          await Promise.all([autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now), learningAfterReviewPromise]);
        } else {
          console.log(`[workflow] review session ${sessionId} completed — auto-merge disabled, leaving in In Review`);
          await learningAfterReviewPromise;
        }
        return;
      }

      let hasCommittedChanges = false;
      if (workspace.workingDir) {
        try {
          if (workspace.isDirect) {
            // Compare against the stored base commit SHA (captured at workspace creation).
            // Falls back to HEAD~1 for workspaces created before this feature.
            const baseRef = workspace.baseCommitSha || "HEAD~1";
            hasCommittedChanges = await new Promise<boolean>((resolve) => {
              execFile("git", ["diff", "--quiet", baseRef, "HEAD"], { cwd: workspace.workingDir! }, (err: Error | null) => {
                resolve(!!err);
              });
            });
          } else {
            const baseBranch = workspace.baseBranch || defaultBranch;
            if (!baseBranch) {
              console.warn(`[workflow] workspace ${workspaceId} has no base/default branch; treating as no committed changes`);
              hasCommittedChanges = false;
            } else {
              hasCommittedChanges = await new Promise<boolean>((resolve) => {
                execFile("git", ["diff", "--quiet", baseBranch], { cwd: workspace.workingDir! }, (err: Error | null) => {
                  resolve(!!err);
                });
              });
            }
          }
        } catch {
          hasCommittedChanges = false;
        }
      }

      // Direct workspaces with no committed changes: close immediately (nothing to review).
      // Direct workspaces WITH changes fall through to the review flow below.
      if (workspace.isDirect && !hasCommittedChanges) {
        const doneStatus = findStatus("Done");
        await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, workspaceId));
        if (doneStatus) {
          await db.update(issues).set({ statusId: doneStatus.id, updatedAt: now }).where(eq(issues.id, issueId));
        }
        boardEvents.broadcast(projectId, "workspace_merged");
        console.log(`[workflow] direct workspace ${workspaceId} closed on agent exit (no committed changes) — issue moved to Done`);
        return;
      }

      if (hasCommittedChanges) {
        console.log(`[workflow] agent session ${sessionId} completed with committed changes — moving to In Review`);
        const inReview = findStatus("In Review");
        if (inReview) {
          await db.update(issues).set({ statusId: inReview.id, updatedAt: now }).where(eq(issues.id, issueId));
        }
        boardEvents.broadcast(projectId, "issue_updated");

        const autoReview = !skipAutoReview && (workspace.requiresReview || prefMap.get("auto_review") !== "false");

        // Optional learning step after agent (runs in parallel with review)
        if (prefMap.get("learning_step_after_agent") === "true" && workspace.workingDir) {
          try {
            const providerLearn = parseProviderPref(prefMap);
            const profileLearn = prefMap.get("claude_profile") || undefined;
            const agentCmdLearn = isMockProfile(profileLearn) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
            const agentArgsLearn = prefMap.get("agent_args") || undefined;
            const claudeProfileLearn = isMockProfile(profileLearn) ? undefined : profileLearn;
            const effectiveProfileLearn = getEffectiveProfile(prefMap, providerLearn, claudeProfileLearn);
            const profileSelectionLearn = effectiveProfileLearn ? { provider: providerLearn, name: effectiveProfileLearn } : undefined;
            const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks.`;
            const learnSessId = await sessionManager.startSession({ workspaceId: workspace.id, prompt: learningPrompt, agentCommand: agentCmdLearn, agentArgs: agentArgsLearn, claudeProfile: effectiveProfileLearn, provider: toExecutorProvider(providerLearn), triggerType: "learning", profile: profileSelectionLearn });
            learningSessionIds.add(learnSessId);
            console.log(`[workflow] learning step (after agent) started: session=${learnSessId}`);
          } catch (err) {
            console.warn("[workflow] learning step (after agent) failed (non-fatal):", err);
          }
        }

        if (autoReview) {
          const reviewProvider = parseProviderPref(prefMap);
          const reviewProfile = prefMap.get("claude_profile") || undefined;
          const agentCommand = isMockProfile(reviewProfile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
          const claudeProfile = isMockProfile(reviewProfile) ? undefined : reviewProfile;
          const effectiveReviewProfile = getEffectiveProfile(prefMap, reviewProvider, claudeProfile);
          const profileSelection = effectiveReviewProfile ? { provider: reviewProvider, name: effectiveReviewProfile } : undefined;
          const reviewArgs = buildReviewArgs(prefMap, reviewProvider);
          // Direct workspaces: never auto-fix on the default branch — reviewer reports only
          const autoFix = workspace.isDirect ? false : prefMap.get("review_auto_fix") !== "false";
          const provider = toExecutorProvider(reviewProvider);
          let diffRef = workspace.baseBranch || defaultBranch;
          let conflictingFiles: string[] | undefined;
          let uncommittedChanges: string[] | undefined;
          if (workspace.isDirect) {
            // Use the commit SHA captured at workspace creation as the diff base
            diffRef = workspace.baseCommitSha || defaultBranch;
          } else if (workspace.workingDir) {
            const baseBranch = workspace.baseBranch || defaultBranch;
            if (!baseBranch) {
              console.warn(`[workflow] cannot launch review for workspace ${workspaceId}: no base/default branch configured`);
              return;
            }
            const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
            diffRef = prep.diffRef;
            if (!prep.success) {
              conflictingFiles = prep.conflictingFiles;
              uncommittedChanges = prep.uncommittedChanges;
              console.warn(`[workflow] rebase failed for workspace ${workspaceId}: ${prep.error} — reviewer will resolve conflicts`);
            }
          }
          const reviewSkillName = workspace.thoroughReview ? "code-review-thorough" : "code-review";
          const verifyAgent = prefMap.get("after_merge_verify_agent") || "none";
          const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, conflictingFiles, uncommittedChanges, workspaceId, reviewSkillName, verifyAgent);
          // `--model` here carries a Claude model from the review skill. Non-Claude
          // providers select models via provider-specific profile/config plumbing.
          const reviewArgsWithModel = (reviewModel && reviewProvider === "claude") ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

          try {
            await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
            boardEvents.broadcast(projectId, "issue_updated");

            const reviewExtraEnv: Record<string, string> = {
              KANBAN_SESSION_TYPE: "review",
              KANBAN_AFTER_MERGE_VERIFY: verifyAgent,
            };
            const reviewSessionId = await sessionManager.startSession({ workspaceId, prompt: reviewPromptText, agentCommand, agentArgs: reviewArgsWithModel, claudeProfile: effectiveReviewProfile, provider, triggerType: "review", profile: profileSelection, extraEnv: reviewExtraEnv });
            reviewSessionIds.add(reviewSessionId);
            console.log(`[workflow] launched ${reviewSkillName} session ${reviewSessionId} for workspace ${workspaceId} (verifyAgent=${verifyAgent})`);
          } catch (err) {
            console.error("[workflow] Failed to launch review session:", err);
          }
        }
      } else {
        console.log(`[workflow] agent session ${sessionId} completed but no committed changes — leaving issue in current status`);
      }
    } catch (err) {
      console.error("[workflow] onSessionExit error:", err);
    }
  }

  /** Tag the issue with "needs-visual-verification" when in after_merge mode and client files changed. */
  async function tagIfNeedsVisualVerification(
    repoPath: string,
    branch: string,
    baseBranch: string | null,
    issueId: string,
    now: string,
  ): Promise<void> {
    try {
      const prefRows = await db.select({ key: preferences.key, value: preferences.value }).from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      if (prefMap.get("visual_verification_mode") !== "after_merge") return;

      const base = baseBranch || "main";
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd: repoPath });
      const changedFiles = stdout.split("\n").map(f => f.trim()).filter(Boolean);
      // Detect frontend file changes regardless of directory structure so the feature works
      // for any project managed by this board, not just the agentic-kanban monorepo.
      const hasClientChanges = changedFiles.some(
        f => /\.(jsx|tsx|css|scss|less|sass|vue|svelte)$/.test(f)
      );
      if (!hasClientChanges) return;

      const TAG_NAME = "needs-visual-verification";
      const TAG_COLOR = "#F59E0B"; // amber

      // Upsert the tag by name: attempt insert (ignore duplicate), then always re-query
      // for the canonical ID. This is race-safe: concurrent merges may both try to insert
      // the tag, but only one will succeed and both will read back the same ID.
      const { randomUUID } = await import("node:crypto");
      await db.insert(tags).values({ id: randomUUID(), name: TAG_NAME, color: TAG_COLOR, isBuiltin: true, createdAt: now })
        .catch(() => {/* tag already exists — safe to ignore */});
      // Ensure existing tag is marked as built-in (for DBs that predate this migration)
      await db.update(tags).set({ isBuiltin: true }).where(eq(tags.name, TAG_NAME))
        .catch(() => {/* non-fatal */});
      const [tagRow] = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, TAG_NAME)).limit(1);
      if (!tagRow) return; // should never happen, but guard anyway
      const tagId = tagRow.id;

      // Add the tag to the issue (ignore duplicate)
      const alreadyTagged = await db.select({ tagId: issueTags.tagId }).from(issueTags)
        .where(eq(issueTags.issueId, issueId)).limit(100);
      const hasTag = alreadyTagged.some(t => t.tagId === tagId);
      if (!hasTag) {
        await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId }).catch(() => {/* already exists */});
        console.log(`[workflow] tagged issue ${issueId} with "${TAG_NAME}"`);
      }
    } catch (err) {
      console.warn("[workflow] tagIfNeedsVisualVerification failed (non-fatal):", err);
    }
  }

  async function autoMerge(
    workspace: { id: string; isDirect: boolean; branch: string; workingDir: string | null; baseBranch: string | null; issueId: string },
    projectId: string,
    issueId: string,
    doneStatusId: string | null,
    now: string,
  ) {
    try {
      // Optional learning step before merge
      const prefRowsLearning = await db.select().from(preferences);
      const prefMapLearning = new Map(prefRowsLearning.map(r => [r.key, r.value]));
      if (prefMapLearning.get("learning_step_before_merge") === "true" && workspace.workingDir) {
        try {
          const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks before this workspace is merged.`;
          const learningProfile = prefMapLearning.get("claude_profile") || undefined;
          const agentCmd = isMockProfile(learningProfile) ? MOCK_AGENT_COMMAND : (prefMapLearning.get("agent_command") || undefined);
          const agentArgs = prefMapLearning.get("agent_args") || undefined;
          const claudeProfile = isMockProfile(learningProfile) ? undefined : learningProfile;
          const providerLearnMerge = parseProviderPref(prefMapLearning);
          const effectiveProfileLearnMerge = getEffectiveProfile(prefMapLearning, providerLearnMerge, claudeProfile);
          const profileSelectionLearnMerge = effectiveProfileLearnMerge ? { provider: providerLearnMerge, name: effectiveProfileLearnMerge } : undefined;
          const learningSessId = await sessionManager.startSession({ workspaceId: workspace.id, prompt: learningPrompt, agentCommand: agentCmd, agentArgs, claudeProfile, profile: profileSelectionLearnMerge, provider: toExecutorProvider(providerLearnMerge), triggerType: "learning" });
          learningSessionIds.add(learningSessId);
          console.log(`[workflow] learning step started: session=${learningSessId}`);
          await new Promise<void>((resolve) => {
            let poll: NodeJS.Timeout;
            const timeout = setTimeout(() => {
              clearInterval(poll);
              console.log("[workflow] learning step timed out after 3m, proceeding with merge");
              resolve();
            }, 3 * 60 * 1000);
            poll = setInterval(async () => {
              const sessRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learningSessId)).limit(1);
              if (sessRows.length > 0 && sessRows[0].status !== "running") {
                clearInterval(poll);
                clearTimeout(timeout);
                console.log(`[workflow] learning step finished: status=${sessRows[0].status}`);
                resolve();
              }
            }, 5000);
          });
        } catch (err) {
          console.warn("[workflow] learning step failed (non-fatal):", err);
        }
      }

      if (!workspace.isDirect) {
        const projectRows = await db.select({ repoPath: projects.repoPath, teardownScript: projects.teardownScript }).from(projects).where(eq(projects.id, projectId)).limit(1);
        if (projectRows.length > 0) {
          const { repoPath, teardownScript } = projectRows[0];
          if (workspace.workingDir) {
            try { await killProcessesInDir(workspace.workingDir); } catch { /* best effort */ }
            if (teardownScript) {
              try { await runScript(teardownScript, workspace.workingDir, `teardown:${workspace.id}`); } catch { /* best effort */ }
            }
          }

          // In after_merge mode, check for client UI changes and tag the issue
          await tagIfNeedsVisualVerification(repoPath, workspace.branch, workspace.baseBranch, issueId, now);

          await gitService.mergeBranch(repoPath, workspace.branch);
          if (workspace.workingDir) {
            try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
          }
          try { await gitService.deleteBranch(repoPath, workspace.branch); } catch { /* best effort */ }

          // In dedicated mode, launch a verification agent on the main checkout after merge
          const verifyAgent = prefMapLearning.get("after_merge_verify_agent") || "none";
          const issueTagged = await db.select({ tagId: issueTags.tagId }).from(issueTags)
            .where(eq(issueTags.issueId, issueId)).limit(100)
            .then(rows => rows.some(r => r.tagId !== null));
          if (verifyAgent === "dedicated" && issueTagged) {
            try {
              const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173";
              const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
              const verifyPrompt = `You are a visual verification agent. The branch '${workspace.branch}' was just merged into master.

Your task: visually verify that the UI changes look correct in the browser.

1. Use the playwright-cli skill (/playwright-cli) or run playwright directly
2. Navigate to http://localhost:${clientPort}
3. Check the relevant UI sections based on the changed files from branch '${workspace.branch}'
4. Take a screenshot confirming the UI renders correctly and report your findings

If the dev server is not responding, wait 10 seconds and retry once.

Issue ID: ${issueId}
Workspace ID: ${workspace.id}
Server: http://localhost:${serverPort}`;
              const verifyProfile = prefMapLearning.get("claude_profile") || undefined;
              const verifyCmd = isMockProfile(verifyProfile) ? MOCK_AGENT_COMMAND : (prefMapLearning.get("agent_command") || undefined);
              const verifyArgs = prefMapLearning.get("agent_args") || undefined;
              const verifyProvider = parseProviderPref(prefMapLearning);
              const effectiveVerifyProfile = getEffectiveProfile(prefMapLearning, verifyProvider, isMockProfile(verifyProfile) ? undefined : verifyProfile);
              const verifyProfileSelection = effectiveVerifyProfile ? { provider: verifyProvider, name: effectiveVerifyProfile } : undefined;
              const verifySessId = await sessionManager.startSession({
                workspaceId: workspace.id,
                prompt: verifyPrompt,
                agentCommand: verifyCmd,
                agentArgs: verifyArgs,
                claudeProfile: effectiveVerifyProfile,
                provider: toExecutorProvider(verifyProvider),
                triggerType: "verify",
                profile: verifyProfileSelection,
                workingDirOverride: repoPath,
                extraEnv: { KANBAN_SESSION_TYPE: "verify" },
              });
              console.log(`[workflow] dedicated verification session started: session=${verifySessId}`);
            } catch (err) {
              console.warn("[workflow] dedicated verification session failed (non-fatal):", err);
            }
          }
        }
      }
      await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, workspace.id));
      if (doneStatusId) {
        await db.update(issues).set({ statusId: doneStatusId, updatedAt: now }).where(eq(issues.id, issueId));
      }
      boardEvents.broadcast(projectId, "workspace_merged");
      console.log(`[workflow] auto-merged workspace ${workspace.id}`);
    } catch (err) {
      console.error("[workflow] auto-merge failed:", err);
      boardEvents.broadcast(projectId, "workflow_error");
    }
  }

  const sessionManager = createSessionManager(upgradeWebSocket, {
    onSessionExit: (workspaceId, sessionId, exitCode, wasPlanMode) => {
      runWorkflowOnExit(workspaceId, sessionId, exitCode, wasPlanMode).catch((err) => {
        console.error("[fatal] runWorkflowOnExit unhandled:", err);
      });
    },
    onActivity: (projectId, issueId, sessionId, activity) => {
      boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity });
    },
    onLiveStats: (projectId, issueId, model, contextTokens, toolUses, subagentCount) => {
      boardEvents.broadcastLiveStats(projectId, issueId, model, contextTokens, toolUses, subagentCount);
    },
    onTodos: (projectId, issueId, todos) => {
      boardEvents.broadcastTodos(projectId, issueId, todos);
    },
  });

  // Manual review trigger
  app.post("/api/workspaces/:id/review", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const body = await c.req.json().catch(() => ({}));
      const thoroughReview = body.thoroughReview === true;
      const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (wsRows.length === 0) return c.json({ error: "Workspace not found" }, 404);
      const workspace = wsRows[0];
      if (workspace.status !== "idle") return c.json({ error: "Workspace is not idle" }, 409);

      const issueRows = await db
        .select({ projectId: issues.projectId, id: issues.id })
        .from(issues)
        .where(eq(issues.id, workspace.issueId))
        .limit(1);
      if (issueRows.length === 0) return c.json({ error: "Issue not found" }, 404);
      const { projectId, id: issueId } = issueRows[0];

      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const manualProfile = prefMap.get("claude_profile") || undefined;
      const agentCommand = isMockProfile(manualProfile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const claudeProfile = isMockProfile(manualProfile) ? undefined : manualProfile;
      const provider = parseProviderPref(prefMap);
      const effectiveProfileName = getEffectiveProfile(prefMap, provider, claudeProfile);
      const manualProfileSelection = effectiveProfileName ? { provider, name: effectiveProfileName } : undefined;
      const reviewArgs = buildReviewArgs(prefMap, provider);
      const autoFix = prefMap.get("review_auto_fix") !== "false";

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;
      let diffRef = workspace.baseBranch || defaultBranch;
      let manualConflictingFiles: string[] | undefined;
      let manualUncommittedChanges: string[] | undefined;
      if (!workspace.isDirect && workspace.workingDir) {
        const baseBranch = workspace.baseBranch || defaultBranch;
        if (!baseBranch) {
          return c.json({ error: "No default branch configured for this project. Set a default branch in project settings before reviewing." }, 400);
        }
        const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
        if (!prep.success) {
          manualConflictingFiles = prep.conflictingFiles;
          manualUncommittedChanges = prep.uncommittedChanges;
          console.warn(`[workflow] rebase failed for manual review ${workspaceId}: ${prep.error}`);
        }
        diffRef = prep.diffRef;
      }
      const manualSkillName = thoroughReview ? "code-review-thorough" : "code-review";
      const verifyAgent = prefMap.get("after_merge_verify_agent") || "none";
      const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, manualConflictingFiles, manualUncommittedChanges, workspaceId, manualSkillName, verifyAgent);
      // `--model` here is a Claude model name / flag; non-Claude providers use profile/config.
      const reviewArgsWithModel = (reviewModel && provider === "claude") ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcast(projectId, "issue_updated");

      const reviewExtraEnv: Record<string, string> = {
        KANBAN_SESSION_TYPE: "review",
        KANBAN_AFTER_MERGE_VERIFY: verifyAgent,
      };
      const reviewSessionId = await sessionManager.startSession({ workspaceId, prompt: reviewPromptText, agentCommand, agentArgs: reviewArgsWithModel, claudeProfile, profile: manualProfileSelection, provider: toExecutorProvider(provider), triggerType: "review", extraEnv: reviewExtraEnv });
      reviewSessionIds.add(reviewSessionId);
      console.log(`[workflow] manual review session ${reviewSessionId} for workspace ${workspaceId}`);

      return c.json({ sessionId: reviewSessionId });
    } catch (err) {
      console.error("[workflow] manual review trigger failed:", err);
      return c.json({ error: String(err) }, 500);
    }
  });

  // WebSocket routes
  app.get("/ws/sessions/:sessionId", sessionManager.wsRoute());
  app.get("/ws/board/:projectId", boardEvents.wsRoute());

  // API routes
  app.route("/api", createRoutes(db, () => sessionManager, { boardEvents, fixAndMergeSessionIds }));
  app.route("/api/sessions", createSessionsRoute(db));

  // Serve built client assets (production/npx mode)
  const clientDir = resolve(__dirname, "./client");
  if (existsSync(resolve(clientDir, "index.html"))) {
    app.use("/*", serveStatic({ root: clientDir }));
    // SPA fallback — serve index.html for non-API, non-WS routes
    app.get("*", serveStatic({ root: clientDir, path: "index.html" }));
  }

  // Start server
  const serverPort = port || Number(process.env.PORT) || 3001;
  const serverHost = hostname || process.env.KANBAN_HOST || "127.0.0.1";

  // Kill orphaned tsx server processes from previous runs that may hold the SQLite DB locked.
  // These accumulate when the server hot-reloads (tsx watch) but old processes don't die cleanly.
  // We only kill processes that match our server's entry point pattern and are NOT us.
  if (process.platform === "win32") {
    try {
      const { execSync: _execSync } = await import("node:child_process");
      const wmic = _execSync(
        `wmic process where "name='node.exe'" get ProcessId,ParentProcessId,CommandLine /format:list`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 8000 },
      );
      const myPid = process.pid;
      const lines = wmic.split(/\r?\n/);
      const procs: { pid: number; ppid: number; cmd: string }[] = [];
      let curCmd = "";
      let curPid = 0;
      let curPpid = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("CommandLine=")) curCmd = trimmed.slice("CommandLine=".length);
        if (trimmed.startsWith("ParentProcessId=")) curPpid = parseInt(trimmed.slice("ParentProcessId=".length), 10);
        if (trimmed.startsWith("ProcessId=")) curPid = parseInt(trimmed.slice("ProcessId=".length), 10);
        if (curCmd && curPid) { procs.push({ pid: curPid, ppid: curPpid, cmd: curCmd }); curCmd = ""; curPid = 0; curPpid = 0; }
      }
      // Build a map for ancestor lookup, then collect the full ancestor chain of our process.
      const ppidMap = new Map(procs.map(p => [p.pid, p.ppid]));
      const ancestors = new Set<number>();
      let ancestor = myPid;
      for (let i = 0; i < 10; i++) {
        const parent = ppidMap.get(ancestor);
        if (!parent || parent === 0 || parent === ancestor) break;
        ancestors.add(parent);
        ancestor = parent;
      }
      let killed = 0;
      for (const p of procs) {
        if (p.pid === myPid || ancestors.has(p.pid)) continue;
        const cmd = p.cmd.replace(/\\/g, "/");
        // Match tsx-based server processes (hot-reload survivors) for the main server entry point.
        // Avoid killing worktree-specific servers by requiring the cmd NOT to contain a worktree path marker.
        if ((cmd.includes("tsx") || cmd.includes("ts-node")) && cmd.includes("src/index") && !cmd.includes(".worktrees")) {
          try {
            _execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: "pipe", windowsHide: true, timeout: 5000 });
            console.log(`[startup] killed orphaned tsx server PID ${p.pid}`);
            killed++;
          } catch { /* already gone */ }
        }
      }
      if (killed > 0) {
        console.log(`[startup] killed ${killed} orphaned tsx server process(es) that may have held the DB locked`);
        // Brief pause to let SQLite release the lock
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.warn("[startup] orphan cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }

  try {
    await applyMigrations(rawClient);
  } catch (err: unknown) {
    console.error("[startup] Migration failed:", err instanceof Error ? err.message : String(err));
    throw err;
  }

  // Ensure required built-in tags exist (idempotent — safe to run on every startup)
  try {
    const { ensureBuiltinTags } = await import("./db/seed.js");
    await ensureBuiltinTags(db);
  } catch (err) {
    console.warn("[startup] ensureBuiltinTags failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // Remove duplicate projects that share the same git root (e.g. a legacy "server" project
  // registered from packages/server before detectRepoInfo added git-root resolution).
  try {
    await deduplicateProjects();
  } catch (err) {
    console.warn("[startup] project deduplication failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  // Disable auto_monitor on every startup — prevents mass agent spawns from idle workspaces
  {
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: "auto_monitor", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });
    console.log("[startup] auto_monitor disabled — re-enable in Settings → Workflow → Board Monitoring");
  }

  // Clean up stale sessions
  // Clean up stale sessions and reattach to surviving agent processes
  const staleSessions = await db.select({
    id: sessions.id,
    workspaceId: sessions.workspaceId,
    pid: sessions.pid,
    executor: sessions.executor,
  }).from(sessions).where(eq(sessions.status, "running"));
  if (staleSessions.length > 0) {
    console.log(`[startup] Checking ${staleSessions.length} running session(s)`);
    const now = new Date().toISOString();
    const dead = [];
    const alive = [];
    for (const s of staleSessions) {
      if (s.pid) {
        try {
          process.kill(s.pid, 0);
          alive.push(s);
        } catch {
          dead.push(s);
        }
      } else {
        dead.push(s);
      }
    }
    for (const s of dead) {
      await db.update(sessions).set({ status: "stopped", endedAt: now }).where(eq(sessions.id, s.id));
    }
    // Only set idle for workspaces whose sessions are dead
    const deadWorkspaceIds = [...new Set(dead.map(s => s.workspaceId))];
    for (const wsId of deadWorkspaceIds) {
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, wsId));
    }
    if (dead.length > 0) {
      console.log(`[startup] ${dead.length} dead session(s) cleaned up`);
    }
    if (alive.length > 0) {
      console.log(`[startup] ${alive.length} session(s) have surviving agent processes — reattaching`);
      for (const s of alive) {
        if (!s.pid) continue;
        // Look up workspace → issue → project for session context
        const wsRows = await db.select({
          issueId: workspaces.issueId,
        }).from(workspaces).where(eq(workspaces.id, s.workspaceId)).limit(1);
        let issueId = "";
        let projectId = "";
        if (wsRows.length > 0) {
          issueId = wsRows[0].issueId;
          const issueRows = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
          if (issueRows.length > 0) projectId = issueRows[0].projectId;
        }
        // Restore session manager in-memory state
        sessionManager.reattachSession({
          sessionId: s.id,
          workspaceId: s.workspaceId,
          issueId,
          projectId,
          providerName: s.executor ?? undefined,
        });
        // Reattach output file watcher and PID exit monitor
        agentService.reattachSession(
          s.id,
          s.pid,
          (event) => { sessionManager.handleOutput(s.id, event); },
          () => {
            sessionManager.notifyExternalExit(s.id, null).catch((err: unknown) => {
              console.error(`[startup] Failed to handle reattached session exit: sessionId=${s.id}`, err);
            });
          },
        );
      }
    }
  }

  // Clean up stale worktrees: closed non-direct workspaces that still have a workingDir
  {
    const staleWs = await db.select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.status, "closed"));
    const staleWithWorktrees = staleWs.filter(ws => ws.workingDir);
    if (staleWithWorktrees.length > 0) {
      console.log(`[startup] Pruning ${staleWithWorktrees.length} stale worktree(s)`);
      for (const ws of staleWithWorktrees) {
        try {
          const issueRows = await db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, ws.issueId)).limit(1);
          if (issueRows.length > 0) {
            const projRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, issueRows[0].projectId)).limit(1);
            if (projRows.length > 0) {
              const { repoPath } = projRows[0];
              try { await gitService.removeWorktree(repoPath, ws.workingDir!); } catch { /* locked — skip */ }
            }
          }
          await db.update(workspaces).set({ workingDir: null, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.id));
        } catch (err) {
          console.warn(`[startup] Failed to prune worktree for workspace ${ws.id}:`, err);
        }
      }
    }
  }

  console.log(`Server starting on port ${serverPort}...`);
  const server = serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, (info) => {
    console.log(`Server running at http://${serverHost}:${info.port}`);
  });

  injectWebSocket(server);

  // Scheduled runs — cron-like timer loop
  async function runScheduledRunsCycle() {
    try {
      const now = new Date();
      const enabled = await db.select().from(scheduledRuns).where(eq(scheduledRuns.enabled, true));
      for (const run of enabled) {
        const lastRun = run.lastRunAt ? new Date(run.lastRunAt) : null;
        let nextRun: Date;
        if (run.cronExpression) {
          const base = lastRun ?? new Date(now.getTime() - 60_000);
          const next = getNextCronRun(run.cronExpression, base);
          if (!next) continue;
          nextRun = next;
        } else {
          nextRun = lastRun
            ? new Date(lastRun.getTime() + run.intervalMinutes * 60 * 1000)
            : now; // first run immediately
        }
        if (now >= nextRun) {
          console.log(`[scheduler] triggering scheduled run "${run.name}" (${run.id})`);
          try {
            const res = await fetch(`http://localhost:${serverPort}/api/scheduled-runs/${run.id}/run`, { method: "POST" });
            if (!res.ok) {
              const body = await res.text();
              console.warn(`[scheduler] run "${run.name}" failed: ${res.status} ${body}`);
            }
          } catch (err) {
            console.warn(`[scheduler] run "${run.name}" error:`, err);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] cycle error:", err);
    }
  }

  // Check every minute
  setInterval(() => { runScheduledRunsCycle().catch(() => {}); }, 60 * 1000);
  // Initial check after 10s (let server fully start)
  setTimeout(() => { runScheduledRunsCycle().catch(() => {}); }, 10 * 1000);

  // Board monitoring loop — periodically checks for stuck/idle workspaces
  let monitorTimer: ReturnType<typeof setTimeout> | null = null;
  let monitorNextRunAt: string | null = null;
  let monitorLastRun: { at: string; relaunched: number; merged: number; nudged: number } | null = null;
  let monitorCurrentIntervalMin: number | null = null;
  type MonitorAction = { at: string; action: MonitorActionName; workspaceId: string; issueId: string };
  const monitorRecentActions: MonitorAction[] = [];

  function logMonitorAction(action: MonitorActionName, workspaceId: string, issueId: string) {
    monitorRecentActions.unshift({ at: new Date().toISOString(), action, workspaceId, issueId });
    if (monitorRecentActions.length > 30) monitorRecentActions.splice(30);
  }

  async function getRecentAgentExcerpts(sessionId: string, count = 3): Promise<string[]> {
    // Fetch last stdout rows for the session and extract assistant text blocks
    const rows = await db.select({ data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(desc(sessionMessages.id))
      .limit(50);

    const excerpts: string[] = [];
    for (const row of rows) {
      if (!row.data || excerpts.length >= count) break;
      const lines = row.data.split("\n").reverse();
      for (const line of lines) {
        if (excerpts.length >= count) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        if (obj.type !== "assistant") continue;
        const content = ((obj.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) || [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            excerpts.push((block.text as string).slice(0, 500));
            if (excerpts.length >= count) break;
          }
        }
      }
    }
    return excerpts;
  }

  function shouldSkipNudge(excerpts: string[]): boolean {
    if (excerpts.length === 0) return false;
    const combined = excerpts.join(" ").toLowerCase();
    // Skip if agent's last message clearly indicates it's still actively working
    const activeSignals = [
      "i'll now", "i will now", "let me now", "next i'll", "continuing",
      "i'm now", "proceeding to", "moving on to", "i've completed",
    ];
    const waitingSignals = [
      "?", "please let me know", "should i", "would you like", "do you want",
      "waiting", "what would", "can you", "could you", "i need your",
    ];
    const hasWaiting = waitingSignals.some(s => combined.includes(s));
    if (hasWaiting) return false; // definitely nudge
    const hasActive = activeSignals.some(s => combined.includes(s));
    return hasActive; // skip if clearly active
  }

  async function runMonitorCycle(force = false) {
    const cycleStats = { relaunched: 0, merged: 0, nudged: 0 };
    try {
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      if (!force && prefMap.get("auto_monitor") !== "true") return;

      const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);

      // Find active workspaces on non-Done/Cancelled issues
      const activeStatuses = await db
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(sql`${projectStatuses.name} NOT IN ('Done', 'Cancelled')`);
      const activeStatusIds = activeStatuses.map(s => s.id);
      if (activeStatusIds.length === 0) return;

      const candidates = await db
        .select({
          wsId: workspaces.id,
          wsStatus: workspaces.status,
          workingDir: workspaces.workingDir,
          isDirect: workspaces.isDirect,
          projectId: issues.projectId,
          issueId: issues.id,
          issueTitle: issues.title,
          issueNumber: issues.issueNumber,
          issueStatusName: projectStatuses.name,
          baseBranch: workspaces.baseBranch,
        })
        .from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id))
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(sql`${workspaces.status} != 'closed' AND ${issues.statusId} IN (${sql.join(activeStatusIds.map(id => sql`${id}`), sql`, `)})`);

      for (const ws of candidates) {
        try {
          const lastSess = await db
            .select({ id: sessions.id, status: sessions.status, startedAt: sessions.startedAt, endedAt: sessions.endedAt, exitCode: sessions.exitCode })
            .from(sessions)
            .where(eq(sessions.workspaceId, ws.wsId))
            .orderBy(desc(sessions.startedAt))
            .limit(1);

          const sess = lastSess[0];

          // Count total sessions for this workspace to detect stuck workspaces
          const sessionCountRows = await db
            .select({ count: sql<number>`count(*)` })
            .from(sessions)
            .where(eq(sessions.workspaceId, ws.wsId));
          const sessionCount = Number(sessionCountRows[0]?.count ?? 0);
          const MAX_SESSIONS = 10;

          if (ws.wsStatus === "idle") {
            // Direct workspaces should never be relaunched - they commit directly to the current checkout.
            // If they're still idle here, runWorkflowOnExit didn't close them (e.g. pre-existing idle from before
            // this fix). Close them now to stop the loop.
            if (ws.isDirect) {
              const now = new Date().toISOString();
              await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
              const doneStatusRow = await db.select({ id: projectStatuses.id }).from(projectStatuses)
                .where(sql`${projectStatuses.name} = 'Done' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
              if (doneStatusRow.length > 0) {
                await db.update(issues).set({ statusId: doneStatusRow[0].id, updatedAt: now }).where(eq(issues.id, ws.issueId)).catch(() => {});
              }
              logMonitorAction("merge", ws.wsId, ws.issueId);
              console.log(`[monitor] Closed stale direct workspace ${ws.wsId} — issue moved to Done`);
              boardEvents.broadcast(ws.projectId, "board_changed");
            } else if (sessionCount >= MAX_SESSIONS) {
              // Too many sessions — flag as needing human review instead of relaunching again
              const needsReviewSt = await db.select({ id: projectStatuses.id }).from(projectStatuses)
                .where(sql`${projectStatuses.name} = 'Needs Review' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
              const inReviewSt = await db.select({ id: projectStatuses.id }).from(projectStatuses)
                .where(sql`${projectStatuses.name} = 'In Review' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
              const fallbackSt = needsReviewSt[0] ?? inReviewSt[0];
              if (fallbackSt) {
                await db.update(issues).set({ statusId: fallbackSt.id }).where(eq(issues.id, ws.issueId)).catch(() => {});
              }
              await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
              logMonitorAction("mark_idle", ws.wsId, ws.issueId);
              console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions — flagged as stuck, closing`);
              boardEvents.broadcast(ws.projectId, "board_changed");
            } else if (sessionCount >= 5 && ws.issueStatusName === "In Review") {
              // Health check: workspace with many sessions stuck in review loop.
              // Close it to stop the cycle — the work is committed, it needs merge or human action.
              await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
              logMonitorAction("mark_idle", ws.wsId, ws.issueId);
              console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions with issue in review — closing to break review loop (merge or create new workspace)`);
              boardEvents.broadcast(ws.projectId, "board_changed");
            } else if (ws.issueStatusName === "In Review") {
              // Workspace is idle but issue is already in review — don't relaunch.
              // The workspace has committed work awaiting review/merge. Relaunching would
              // start a blind implementation session that overwrites or duplicates work.
              console.log(`[monitor] Skipping relaunch for idle workspace ${ws.wsId} — issue #${ws.issueNumber} is in review (committed work awaiting merge)`);
            } else {
            // Relaunch idle workspaces
            const baseUrl = `http://localhost:${serverPort}`;
            await fetch(`${baseUrl}/api/workspaces/${ws.wsId}/launch`, { method: "POST" }).catch(() => {});
            cycleStats.relaunched++;
            logMonitorAction("relaunch", ws.wsId, ws.issueId);
            console.log(`[monitor] Relaunched idle workspace ${ws.wsId}`);
            boardEvents.broadcast(ws.projectId, "board_changed");
            }
          } else if (ws.wsStatus === "reviewing") {
            // Ghost workspace: workingDir is empty — branch/worktree is gone, merge will always fail
            if (!ws.workingDir) {
              console.log(`[monitor] Ghost workspace ${ws.wsId} (workingDir empty) — deleting and resetting issue to In Progress`);
              const baseUrl = `http://localhost:${serverPort}`;
              await fetch(`${baseUrl}/api/workspaces/${ws.wsId}`, { method: "DELETE" }).catch(() => {});
              // Move issue back to In Progress
              const inProgressSt = await db
                .select({ id: projectStatuses.id })
                .from(projectStatuses)
                .where(sql`${projectStatuses.name} = 'In Progress' AND ${projectStatuses.projectId} = ${ws.projectId}`)
                .limit(1);
              if (inProgressSt.length > 0) {
                await db.update(issues).set({ statusId: inProgressSt[0].id }).where(eq(issues.id, ws.issueId)).catch(() => {});
              }
              logMonitorAction("mark_idle", ws.wsId, ws.issueId);
              boardEvents.broadcast(ws.projectId, "board_changed");
            } else if (sess && sess.status === "stopped") {
            // Trigger merge for reviewing workspaces with stopped sessions
            const baseUrl = `http://localhost:${serverPort}`;
            await fetch(`${baseUrl}/api/workspaces/${ws.wsId}/merge`, { method: "POST" }).catch(() => {});
            cycleStats.merged++;
            logMonitorAction("merge", ws.wsId, ws.issueId);
            console.log(`[monitor] Triggered merge for reviewing workspace ${ws.wsId}`);
            boardEvents.broadcast(ws.projectId, "board_changed");
            }
          } else if (ws.wsStatus === "active" && sess && sess.status === "stopped") {
            // Active workspace but session has stopped — agent exited without transitioning workspace.
            if (ws.isDirect) {
              // Direct workspaces should not be relaunched — close immediately.
              const now = new Date().toISOString();
              await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
              const doneStatusRow = await db.select({ id: projectStatuses.id }).from(projectStatuses)
                .where(sql`${projectStatuses.name} = 'Done' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
              if (doneStatusRow.length > 0) {
                await db.update(issues).set({ statusId: doneStatusRow[0].id, updatedAt: now }).where(eq(issues.id, ws.issueId)).catch(() => {});
              }
              logMonitorAction("merge", ws.wsId, ws.issueId);
              console.log(`[monitor] Direct active workspace ${ws.wsId} has stopped session — closing`);
            } else {
            // Mark workspace as idle so the next cycle will relaunch it.
            await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
            logMonitorAction("mark_idle", ws.wsId, ws.issueId);
            console.log(`[monitor] Active workspace ${ws.wsId} has stopped session — marking idle for relaunch`);
            }
            boardEvents.broadcast(ws.projectId, "board_changed");
          } else if (ws.wsStatus === "active" && sess && sess.status === "running") {
            // Check if process is actually alive; if not, mark idle
            const isAlive = sessionManager.isProcessAlive(sess.id);
            if (!isAlive) {
              // Process died without updating DB — treat as stopped
              await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
              await db.update(sessions).set({ status: "stopped", endedAt: new Date().toISOString() }).where(eq(sessions.id, sess.id)).catch(() => {});
              logMonitorAction("mark_dead", ws.wsId, ws.issueId);
              console.log(`[monitor] Workspace ${ws.wsId} process dead — marking idle`);
              boardEvents.broadcast(ws.projectId, "board_changed");
            } else {
              // Check if agent is waiting for input (running > 5min without activity)
              const runningMs = Date.now() - new Date(sess.startedAt).getTime();
              if (runningMs > 5 * 60 * 1000) {
                // Check if we've already nudged this workspace before (repeat nudge scenario)
                const previousNudge = monitorRecentActions.find(
                  a => a.action === "nudge" && a.workspaceId === ws.wsId
                );

                if (previousNudge) {
                  // Before re-nudging, check what the agent last said
                  const excerpts = await getRecentAgentExcerpts(sess.id);
                  if (shouldSkipNudge(excerpts)) {
                    console.log(`[monitor] Skipping re-nudge for workspace ${ws.wsId} — agent appears to be actively working`);
                    continue;
                  }
                  if (excerpts.length > 0) {
                    console.log(`[monitor] Re-nudging workspace ${ws.wsId} — last agent excerpt: "${excerpts[0]?.slice(0, 100)}..."`);
                  }
                }

                const prompt = await buildMonitorNudgePrompt(ws.projectId);
                const nudged = sendMonitorNudge({
                  sessionManager,
                  sessionId: sess.id,
                  workspaceId: ws.wsId,
                  issueId: ws.issueId,
                  projectId: ws.projectId,
                  prompt,
                  logAction: logMonitorAction,
                  broadcast: (projectId, event) => boardEvents.broadcast(projectId, event),
                });
                if (nudged) cycleStats.nudged++;
              }
            }
          }
        } catch (err) {
          console.warn(`[monitor] Error processing workspace ${ws.wsId}:`, err);
        }
      }
      // Auto-start In Progress issues that have no open workspace (e.g. manually moved without creating workspace)
      // Respects the same WIP limit as auto-start for Todo items.
      if (prefMap.get("nudge_auto_start") === "true") {
        const wipLimit = parseInt(prefMap.get("nudge_wip_limit") || "5", 10);
        const inProgressStatuses = await db
          .select({ id: projectStatuses.id, projectId: projectStatuses.projectId })
          .from(projectStatuses)
          .where(sql`${projectStatuses.name} = 'In Progress'`);
        for (const inProgressSt of inProgressStatuses) {
          // Count active workspace slots consumed in this project
          const activeWipRows = await db
            .select({ count: sql<number>`count(distinct ${issues.id})` })
            .from(issues)
            .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
            .where(sql`${issues.statusId} = ${inProgressSt.id} AND ${workspaces.status} != 'closed'`);
          let currentWip = activeWipRows[0]?.count ?? 0;
          if (currentWip >= wipLimit) continue;

          const inProgressIssues = await db
            .select({ id: issues.id, title: issues.title, description: issues.description, issueNumber: issues.issueNumber })
            .from(issues)
            .where(eq(issues.statusId, inProgressSt.id));
          for (const issue of inProgressIssues) {
            if (currentWip >= wipLimit) break;
            const openWs = await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`)
              .limit(1);
            if (openWs.length > 0) continue;
            // No open workspace — create one and launch
            const baseUrl = `http://localhost:${serverPort}`;
            const branchSlug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 40);
            const branch = `feature/ak-${issue.issueNumber}-${branchSlug}`;
            const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
            await fetch(`${baseUrl}/api/workspaces`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ issueId: issue.id, branch, customPrompt: prompt }),
            }).catch(() => {});
            currentWip++;
            logMonitorAction("auto_start", "", issue.id);
            boardEvents.broadcast(inProgressSt.projectId, "board_changed");
            console.log(`[monitor] Auto-started workspace for In Progress issue #${issue.issueNumber} (no open workspace)`);
          }
        }
      }

      // Auto-start unblocked Todo items if enabled
      if (prefMap.get("nudge_auto_start") === "true") {
        const wipLimit = parseInt(prefMap.get("nudge_wip_limit") || "5", 10);

        // Count current In Progress issues that have an open workspace (true WIP = agent work in flight)
        const inProgressStatus = await db
          .select({ id: projectStatuses.id, projectId: projectStatuses.projectId })
          .from(projectStatuses)
          .where(sql`${projectStatuses.name} = 'In Progress'`);

        for (const inProgressSt of inProgressStatus) {
          // Count only issues with an open workspace (agent work actually in flight)
          const inProgressCount = await db
            .select({ count: sql<number>`count(distinct ${issues.id})` })
            .from(issues)
            .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
            .where(sql`${issues.statusId} = ${inProgressSt.id} AND ${workspaces.status} != 'closed'`);
          const currentWip = inProgressCount[0]?.count ?? 0;
          if (currentWip >= wipLimit) continue;

          // Find Todo status for the same project
          const todoStatus = await db
            .select({ id: projectStatuses.id })
            .from(projectStatuses)
            .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`)
            .limit(1);
          if (todoStatus.length === 0) continue;

          const slotsAvailable = wipLimit - currentWip;

          // Find Todo issues with no open workspace and all dependencies satisfied
          const todoIssues = await db
            .select({ id: issues.id, title: issues.title, projectId: issues.projectId, issueNumber: issues.issueNumber })
            .from(issues)
            .where(eq(issues.statusId, todoStatus[0].id))
            .limit(slotsAvailable * 3); // fetch extra to filter by dependencies

          // Get all done/cancelled status IDs for any project (for dependency check)
          const doneStatuses = await db
            .select({ id: projectStatuses.id })
            .from(projectStatuses)
            .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
          const doneStatusIds = new Set(doneStatuses.map(s => s.id));

          let started = 0;
          for (const issue of todoIssues) {
            if (started >= slotsAvailable) break;

            // Check if issue already has an open workspace
            const existingWs = await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(sql`${workspaces.issueId} = ${issue.id} AND ${workspaces.status} != 'closed'`)
              .limit(1);
            if (existingWs.length > 0) continue;

            // Check all dependencies are resolved (depends_on type — blocker must be done/cancelled)
            const deps = await db
              .select({ dependsOnId: issueDependencies.dependsOnId })
              .from(issueDependencies)
              .where(sql`${issueDependencies.issueId} = ${issue.id} AND ${issueDependencies.type} = 'depends_on'`);

            if (deps.length > 0) {
              const blockerIssues = await db
                .select({ statusId: issues.statusId })
                .from(issues)
                .where(sql`${issues.id} IN (${sql.join(deps.map(d => sql`${d.dependsOnId}`), sql`, `)})`);
              const allResolved = blockerIssues.every(b => b.statusId && doneStatusIds.has(b.statusId));
              if (!allResolved) continue;
            }

            // Create workspace for this issue (branch name required by API)
            const slug = issue.title
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, "")
              .replace(/\s+/g, "-")
              .slice(0, 40)
              .replace(/-+$/, "");
            const branch = `feature/ak-${issue.issueNumber}-${slug}`;
            const baseUrl = `http://localhost:${serverPort}`;
            const resp = await fetch(`${baseUrl}/api/workspaces`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ issueId: issue.id, branch }),
            }).catch(() => null);

            if (resp && resp.ok) {
              const wsData = await resp.json().catch(() => null) as { id?: string } | null;
              const wsId = wsData?.id ?? "unknown";
              logMonitorAction("auto_start", wsId, issue.id);
              console.log(`[monitor] Auto-started workspace for unblocked issue "${issue.title}" (${issue.id})`);
              boardEvents.broadcast(issue.projectId, "board_changed");
              started++;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[monitor] Cycle error:", err);
    } finally {
      monitorLastRun = { at: new Date().toISOString(), ...cycleStats };
      // Reschedule based on current preference
      const prefRows = await db.select().from(preferences).catch(() => []);
      const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
      if (prefMap.get("auto_monitor") === "true") {
        const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
        monitorNextRunAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
        monitorTimer = setTimeout(runMonitorCycle, intervalMin * 60 * 1000);
      } else {
        monitorNextRunAt = null;
      }
    }
  }

  // Watch for preference changes to start/stop monitoring
  async function syncMonitorState() {
    const prefRows = await db.select().from(preferences).catch(() => []);
    const prefMap = new Map(prefRows.map((r: { key: string; value: string }) => [r.key, r.value]));
    const enabled = prefMap.get("auto_monitor") === "true";
    const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
    if (enabled && (!monitorTimer || intervalMin !== monitorCurrentIntervalMin)) {
      if (monitorTimer && intervalMin !== monitorCurrentIntervalMin) {
        console.log(`[monitor] Interval changed to ${intervalMin}m — restarting monitor immediately`);
        clearTimeout(monitorTimer);
        monitorTimer = null;
      } else {
        console.log(`[monitor] Starting board monitoring loop (every ${intervalMin}m) — running immediately`);
      }
      monitorCurrentIntervalMin = intervalMin;
      monitorNextRunAt = null;
      // Set a placeholder so syncMonitorState won't re-enter on the next 30s poll
      monitorTimer = setTimeout(() => {}, 0);
      // Run now; runMonitorCycle finally block will reschedule the real timer
      runMonitorCycle().catch(() => {});
    } else if (!enabled && monitorTimer) {
      console.log("[monitor] Stopping board monitoring loop");
      clearTimeout(monitorTimer);
      monitorTimer = null;
      monitorNextRunAt = null;
      monitorCurrentIntervalMin = null;
    }
  }

  // Poll for preference changes every 30s to pick up toggle changes from UI
  setInterval(syncMonitorState, 30_000);
  // Also run once at startup
  syncMonitorState().catch(() => {});

  // Trigger an immediate monitor run and reset the interval timer
  app.post("/api/internal/monitor-run", async (c) => {
    if (monitorTimer) {
      clearTimeout(monitorTimer);
    }
    // Placeholder prevents syncMonitorState from starting a duplicate run while this one is in flight
    monitorTimer = setTimeout(() => {}, 0);
    monitorNextRunAt = null;
    // Run in background; reschedule is handled inside runMonitorCycle's finally block
    runMonitorCycle(true).catch(() => {});
    return c.json({ triggered: true });
  });

  // Expose monitor state via internal endpoint so UI can show it
  app.get("/api/internal/monitor-status", async (c) => {
    const prefRows = await db.select().from(preferences);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
    return c.json({
      enabled: prefMap.get("auto_monitor") === "true",
      intervalMin: parseInt(prefMap.get("auto_monitor_interval") || "4", 10),
      active: monitorTimer !== null,
      lastRun: monitorLastRun,
      nextRunAt: monitorNextRunAt,
      recentActions: monitorRecentActions,
    });
  });

  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[fatal] Port already in use — exiting:", err.message);
      process.exit(1);
    }
    console.error("[error] Uncaught exception (recoverable):", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[error] Unhandled rejection (suppressed):", reason);
  });

  function shutdown(signal: string) {
    // Agent processes are spawned detached+unref'd — they survive hot-reload without being killed.
    // Only kill them on explicit SIGINT (user Ctrl+C) to avoid orphaning on intentional shutdown.
    const activeCount = signal === "SIGINT" ? agentService.killAll() : 0;
    console.log(`[shutdown] Received ${signal} — closing server (${activeCount} agent process(es) terminated, survivors continue)...`);
    server.close(() => {
      console.log("[shutdown] Server closed.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[shutdown] Forced exit after 5s timeout");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { app, sessionManager, boardEvents };
}
