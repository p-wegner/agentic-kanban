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
import { createBoardEvents } from "./services/board-events.js";
import { workspaces, issues, projects, projectStatuses, preferences, sessions, agentSkills } from "@agentic-kanban/shared/schema";
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

Issue ID: {{issueId}}`;

function buildReviewArgs(prefMap: Map<string, string>): string | undefined {
  const skipPerms = prefMap.get("skip_permissions") === "true";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

async function buildReviewPrompt(branch: string, baseBranch: string | null, issueId: string, autoFix: boolean, projectId?: string, conflictingFiles?: string[]): Promise<string> {
  let template: string | null = null;
  if (projectId) {
    const projectSkill = await db.select({ prompt: agentSkills.prompt }).from(agentSkills)
      .where(sql`${agentSkills.name} = 'code-review' AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    template = projectSkill[0]?.prompt ?? null;
  }
  if (!template) {
    template = DEFAULT_REVIEW_PROMPT;
  }

  const autoFixInstructions = autoFix
    ? `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress' (so the board shows the issue needs fixes)
2. Fix all critical and major issues directly in the code
3. Commit the fixes with a descriptive message
4. Exit normally (the system will handle merging)

If only MINOR issues or no issues: just exit normally (the system will auto-merge).`
    : `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress'
2. Describe each issue clearly so the developer knows what to fix
3. Do NOT edit any files — report only

If only MINOR issues or no issues: just exit normally (the system will auto-merge).`;

  let conflictPreamble = "";
  if (conflictingFiles && conflictingFiles.length > 0) {
    conflictPreamble = `IMPORTANT: There are rebase conflicts that must be resolved before reviewing.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}

Steps to resolve:
1. For each conflicting file, open it and resolve the conflict markers (<<<<<<<, =======, >>>>>>>)
2. After resolving all files, run: git add <resolved-files>
3. Continue the rebase: git rebase --continue
4. Commit any remaining changes if needed

Only after resolving all conflicts and completing the rebase, proceed with the code review below.

---

`;
  }

  return conflictPreamble + template
    .replace(/\{\{branch}}/g, branch)
    .replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD")
    .replace(/\{\{issueId}}/g, issueId)
    .replace(/\{\{autoFixInstructions}}/g, autoFixInstructions);
}

export async function startServer(port?: number) {
  const app = new Hono();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const boardEvents = createBoardEvents(upgradeWebSocket);
  const reviewSessionIds = new Set<string>();

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

      if (exitCode !== 0) return;

      const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      const findStatus = (name: string) => statuses.find(s => s.name === name);

      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const autoMergeEnabled = prefMap.get("auto_merge") !== "false";

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : "main";

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

        if (autoMergeEnabled) {
          console.log(`[workflow] review session ${sessionId} completed — auto-merging`);
          await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
        } else {
          console.log(`[workflow] review session ${sessionId} completed — auto-merge disabled, leaving in In Review`);
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

        if (autoReview) {
          const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
          const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
          const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);
          const reviewArgs = buildReviewArgs(prefMap);
          const autoFix = prefMap.get("review_auto_fix") !== "false";

          let diffRef = workspace.baseBranch || defaultBranch;
          let conflictingFiles: string[] | undefined;
          if (!workspace.isDirect && workspace.workingDir) {
            const baseBranch = workspace.baseBranch || defaultBranch;
            const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
            diffRef = prep.diffRef;
            if (!prep.success) {
              conflictingFiles = prep.conflictingFiles;
              console.warn(`[workflow] rebase failed for workspace ${workspaceId}: ${prep.error} — reviewer will resolve conflicts`);
            }
          }
          const reviewPrompt = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, conflictingFiles);

          try {
            await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
            boardEvents.broadcast(projectId, "issue_updated");

            const reviewSessionId = await sessionManager.startSession(workspaceId, reviewPrompt, agentCommand, reviewArgs, undefined, claudeProfile);
            reviewSessionIds.add(reviewSessionId);
            console.log(`[workflow] launched review session ${reviewSessionId} for workspace ${workspaceId}`);
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

      const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
      const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : "main";
      let diffRef = workspace.baseBranch || defaultBranch;
      if (!workspace.isDirect && workspace.workingDir) {
        const baseBranch = workspace.baseBranch || defaultBranch;
        const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
        if (!prep.success) {
          console.warn(`[workflow] merge-base failed for manual review ${workspaceId}: ${prep.error}`);
        }
        diffRef = prep.diffRef;
      }
      const reviewPrompt = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId);

      const now = new Date().toISOString();
      await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
      boardEvents.broadcast(projectId, "issue_updated");

      const reviewSessionId = await sessionManager.startSession(workspaceId, reviewPrompt, agentCommand, reviewArgs, undefined, claudeProfile);
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
  app.route("/api", createRoutes(db, () => sessionManager, { boardEvents }));
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

  // Clean up stale sessions
  const staleSessions = await db.select({ workspaceId: sessions.workspaceId }).from(sessions).where(eq(sessions.status, "running"));
  if (staleSessions.length > 0) {
    console.log(`[startup] Cleaning up ${staleSessions.length} stale session(s)`);
    const now = new Date().toISOString();
    await db.update(sessions).set({ status: "stopped", endedAt: now }).where(eq(sessions.status, "running"));
    const workspaceIds = [...new Set(staleSessions.map(s => s.workspaceId))];
    for (const wsId of workspaceIds) {
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, wsId));
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
    const activeCount = agentService.killAll();
    console.log(`[shutdown] Received ${signal} — closing server (${activeCount} agent process(es) terminated)...`);
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
