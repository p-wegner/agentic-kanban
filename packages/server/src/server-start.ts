import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { createRoutes } from "./routes/index.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { createSessionManager } from "./services/session.manager.js";
import type { ProviderId } from "./services/agent-provider.js";
import { createBoardEvents } from "./services/board-events.js";
import { workspaces, issues, projects, projectStatuses, preferences, sessions, agentSkills, issueDependencies } from "@agentic-kanban/shared/schema";
import { eq, sql, desc } from "drizzle-orm";
import * as agentService from "./services/agent.service.js";
import * as gitService from "./services/git.service.js";
import { killProcessesInDir } from "./services/process-cleanup.js";
import { runScript } from "./services/script-runner.js";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { getMigrationsFolder } from "./db/migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "./scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

const DEFAULT_REVIEW_PROMPT = `You are an AI code reviewer. Review the changes on branch '{{branch}}'.

First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`;

function buildReviewArgs(prefMap: Map<string, string>): string | undefined {
  const skipPerms = prefMap.get("skip_permissions") === "true";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

async function buildReviewPrompt(branch: string, baseBranch: string | null, issueId: string, autoFix: boolean, projectId?: string, conflictingFiles?: string[], uncommittedChanges?: string[], workspaceId?: string, skillName = "code-review"): Promise<{ prompt: string; model: string | null }> {
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

  // Strip "origin/" prefix so rebase instructions use the bare branch name (e.g. "master" not "origin/master")
  const localBaseBranch = (baseBranch ?? "master").replace(/^origin\//, "");

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

  const prompt = conflictPreamble + template
    .replace(/\{\{branch}}/g, branch)
    .replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD")
    .replace(/\{\{issueId}}/g, issueId)
    .replace(/\{\{workspaceId}}/g, workspaceId ?? "")
    .replace(/\{\{autoFixInstructions}}/g, autoFixInstructions);
  return { prompt, model: skillModel };
}

export async function startServer(port?: number) {
  const app = new Hono();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents(upgradeWebSocket);
  const reviewSessionIds = new Set<string>();
  const fixAndMergeSessionIds = new Set<string>();
  const learningSessionIds = new Set<string>();

  async function runWorkflowOnExit(workspaceId: string, sessionId: string, exitCode: number | null) {
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

      boardEvents.broadcast(projectId, "session_completed");

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcast(projectId, "workspace_idle");

      const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      const findStatus = (name: string) => statuses.find(s => s.name === name);

      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const autoMergeEnabled = prefMap.get("auto_merge") !== "false";

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : "main";

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
            const useMockLearn = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
            const agentCmdLearn = useMockLearn ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
            const agentArgsLearn = prefMap.get("agent_args") || undefined;
            const claudeProfileLearn = useMockLearn ? undefined : (prefMap.get("claude_profile") || undefined);
            const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks.`;
            const learnSessId = await sessionManager.startSession(workspace.id, learningPrompt, agentCmdLearn, agentArgsLearn ? agentArgsLearn.split(" ") : undefined, undefined, claudeProfileLearn);
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
            hasCommittedChanges = await new Promise<boolean>((resolve) => {
              execFile("git", ["diff", "--quiet", "HEAD"], { cwd: workspace.workingDir! }, (err: Error | null) => {
                resolve(!!err);
              });
            });
          } else {
            const baseBranch = workspace.baseBranch || defaultBranch;
            hasCommittedChanges = await new Promise<boolean>((resolve) => {
              execFile("git", ["diff", "--quiet", baseBranch], { cwd: workspace.workingDir! }, (err: Error | null) => {
                resolve(!!err);
              });
            });
          }
        } catch {
          hasCommittedChanges = false;
        }
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
            const useMockLearn = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
            const agentCmdLearn = useMockLearn ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
            const agentArgsLearn = prefMap.get("agent_args") || undefined;
            const claudeProfileLearn = useMockLearn ? undefined : (prefMap.get("claude_profile") || undefined);
            const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks.`;
            const learnSessId = await sessionManager.startSession(workspace.id, learningPrompt, agentCmdLearn, agentArgsLearn ? agentArgsLearn.split(" ") : undefined, undefined, claudeProfileLearn);
            learningSessionIds.add(learnSessId);
            console.log(`[workflow] learning step (after agent) started: session=${learnSessId}`);
          } catch (err) {
            console.warn("[workflow] learning step (after agent) failed (non-fatal):", err);
          }
        }

        if (autoReview) {
          const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
          const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
          const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);
          const reviewArgs = buildReviewArgs(prefMap);
          const autoFix = prefMap.get("review_auto_fix") !== "false";
          const provider = (prefMap.get("provider") || undefined) as ProviderId | undefined;

          let diffRef = workspace.baseBranch || defaultBranch;
          let conflictingFiles: string[] | undefined;
          let uncommittedChanges: string[] | undefined;
          if (!workspace.isDirect && workspace.workingDir) {
            const baseBranch = workspace.baseBranch || defaultBranch;
            const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
            diffRef = prep.diffRef;
            if (!prep.success) {
              conflictingFiles = prep.conflictingFiles;
              uncommittedChanges = prep.uncommittedChanges;
              console.warn(`[workflow] rebase failed for workspace ${workspaceId}: ${prep.error} — reviewer will resolve conflicts`);
            }
          }
          const reviewSkillName = workspace.thoroughReview ? "code-review-thorough" : "code-review";
          const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, conflictingFiles, uncommittedChanges, workspaceId, reviewSkillName);
          const reviewArgsWithModel = reviewModel ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

          try {
            await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
            boardEvents.broadcast(projectId, "issue_updated");

            const reviewSessionId = await sessionManager.startSession(workspaceId, reviewPromptText, agentCommand, reviewArgsWithModel, undefined, claudeProfile, undefined, undefined, undefined, undefined, provider);
            reviewSessionIds.add(reviewSessionId);
            console.log(`[workflow] launched ${reviewSkillName} session ${reviewSessionId} for workspace ${workspaceId}`);
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
          const agentCmd = prefMapLearning.get("agent_command") || undefined;
          const agentArgs = prefMapLearning.get("agent_args") || undefined;
          const claudeProfile = prefMapLearning.get("claude_profile") || undefined;
          const learningSessId = await sessionManager.startSession(workspace.id, learningPrompt, agentCmd, agentArgs ? agentArgs.split(" ") : undefined, undefined, claudeProfile);
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
          await gitService.mergeBranch(repoPath, workspace.branch);
          if (workspace.workingDir) {
            try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
          }
          try { await gitService.deleteBranch(repoPath, workspace.branch); } catch { /* best effort */ }
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
    onSessionExit: (workspaceId, sessionId, exitCode) => {
      runWorkflowOnExit(workspaceId, sessionId, exitCode).catch((err) => {
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
      const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
      const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);
      const reviewArgs = buildReviewArgs(prefMap);
      const autoFix = prefMap.get("review_auto_fix") !== "false";
      const provider = (prefMap.get("provider") || undefined) as ProviderId | undefined;

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : "main";
      let diffRef = workspace.baseBranch || defaultBranch;
      let manualConflictingFiles: string[] | undefined;
      let manualUncommittedChanges: string[] | undefined;
      if (!workspace.isDirect && workspace.workingDir) {
        const baseBranch = workspace.baseBranch || defaultBranch;
        const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
        if (!prep.success) {
          manualConflictingFiles = prep.conflictingFiles;
          manualUncommittedChanges = prep.uncommittedChanges;
          console.warn(`[workflow] rebase failed for manual review ${workspaceId}: ${prep.error}`);
        }
        diffRef = prep.diffRef;
      }
      const manualSkillName = thoroughReview ? "code-review-thorough" : "code-review";
      const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, manualConflictingFiles, manualUncommittedChanges, workspaceId, manualSkillName);
      const reviewArgsWithModel = reviewModel ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcast(projectId, "issue_updated");

      const reviewSessionId = await sessionManager.startSession(workspaceId, reviewPromptText, agentCommand, reviewArgsWithModel, undefined, claudeProfile, undefined, undefined, undefined, undefined, provider);
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
    app.use("/*", serveStatic({ root: "./client" }));
    // SPA fallback — serve index.html for non-API, non-WS routes
    app.get("*", serveStatic({ root: "./client", path: "index.html" }));
  }

  // Start server
  const serverPort = port || Number(process.env.PORT) || 3001;

  await migrate(db, { migrationsFolder: getMigrationsFolder() });

  // Clean up stale sessions — but skip any whose agent process is still alive (survived hot-reload)
  const staleSessions = await db.select({ id: sessions.id, workspaceId: sessions.workspaceId, pid: sessions.pid }).from(sessions).where(eq(sessions.status, "running"));
  if (staleSessions.length > 0) {
    const now = new Date().toISOString();
    const dead = staleSessions.filter(s => {
      if (!s.pid) return true;
      try { process.kill(s.pid, 0); return false; } catch { return true; }
    });
    const alive = staleSessions.filter(s => !dead.includes(s));
    if (alive.length > 0) {
      console.log(`[startup] ${alive.length} session(s) have surviving agent processes — leaving as running`);
    }
    if (dead.length > 0) {
      console.log(`[startup] Cleaning up ${dead.length} dead stale session(s)`);
      const deadIds = dead.map(s => s.id);
      await db.update(sessions).set({ status: "stopped", endedAt: now }).where(sql`${sessions.id} IN (${sql.join(deadIds.map(id => sql`${id}`), sql`, `)})`);
      const workspaceIds = [...new Set(dead.map(s => s.workspaceId))];
      for (const wsId of workspaceIds) {
        await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, wsId));
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
  const server = serve({ fetch: app.fetch, port: serverPort }, (info) => {
    console.log(`Server running at http://localhost:${info.port}`);
  });

  injectWebSocket(server);

  // Scheduled runs — cron-like timer loop
  async function runScheduledRunsCycle() {
    try {
      const now = new Date();
      const enabled = await db.select().from(scheduledRuns).where(eq(scheduledRuns.enabled, true));
      for (const run of enabled) {
        const lastRun = run.lastRunAt ? new Date(run.lastRunAt) : null;
        const nextRun = lastRun
          ? new Date(lastRun.getTime() + run.intervalMinutes * 60 * 1000)
          : now; // first run immediately
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
  type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start"; workspaceId: string; issueId: string };
  const monitorRecentActions: MonitorAction[] = [];

  function logMonitorAction(action: MonitorAction["action"], workspaceId: string, issueId: string) {
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
          projectId: issues.projectId,
          issueId: issues.id,
          issueTitle: issues.title,
          issueNumber: issues.issueNumber,
        })
        .from(workspaces)
        .innerJoin(issues, eq(workspaces.issueId, issues.id))
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

          if (ws.wsStatus === "idle") {
            // Relaunch idle workspaces
            const baseUrl = `http://localhost:${serverPort}`;
            await fetch(`${baseUrl}/api/workspaces/${ws.wsId}/launch`, { method: "POST" }).catch(() => {});
            cycleStats.relaunched++;
            logMonitorAction("relaunch", ws.wsId, ws.issueId);
            console.log(`[monitor] Relaunched idle workspace ${ws.wsId}`);
            boardEvents.broadcast(ws.projectId, "board_changed");
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
            // Mark workspace as idle so the next cycle will relaunch it.
            await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
            logMonitorAction("mark_idle", ws.wsId, ws.issueId);
            console.log(`[monitor] Active workspace ${ws.wsId} has stopped session — marking idle for relaunch`);
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


                console.log(`[monitor] Nudged long-running agent in workspace ${ws.wsId}`);
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
    if (enabled && !monitorTimer) {
      const intervalMin = parseInt(prefMap.get("auto_monitor_interval") || "4", 10);
      console.log(`[monitor] Starting board monitoring loop (every ${intervalMin}m) — running immediately`);
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
      monitorTimer = null;
    }
    monitorNextRunAt = null;
    // Run in background; reschedule is handled inside runMonitorCycle
    runMonitorCycle().catch(() => {});
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
