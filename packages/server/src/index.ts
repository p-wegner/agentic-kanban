import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { createRoutes } from "./routes/index.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { createSessionManager } from "./services/session.manager.js";
import { createBoardEvents } from "./services/board-events.js";
import { workspaces, issues, projects, projectStatuses, preferences, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as agentService from "./services/agent.service.js";
import * as gitService from "./services/git.service.js";
import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "./scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

const app = new Hono();

// Middleware
app.use("/api/*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// WebSocket setup
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Board events service
const boardEvents = createBoardEvents(upgradeWebSocket);

// Track which sessions are review sessions (in-memory — fine for single-process server)
const reviewSessionIds = new Set<string>();

function buildReviewArgs(prefMap: Map<string, string>): string | undefined {
  const skipPerms = prefMap.get("skip_permissions") === "true";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

function buildReviewPrompt(branch: string, baseBranch: string | null, issueId: string, autoFix: boolean): string {
  const lines = [
    `You are an AI code reviewer. Review the changes on branch '${branch}'.`,
    `Run 'git diff ${baseBranch ?? "HEAD"}' to see the diff.`,
    ``,
    `Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.`,
    `Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).`,
    ``,
  ];
  if (autoFix) {
    lines.push(
      `If you find CRITICAL or MAJOR issues:`,
      `1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress' (so the board shows the issue needs fixes)`,
      `2. Fix all critical and major issues directly in the code`,
      `3. Commit the fixes with a descriptive message`,
      `4. Exit normally (the system will handle merging)`,
      ``,
      `If only MINOR issues or no issues: just exit normally (the system will auto-merge).`,
    );
  } else {
    lines.push(
      `If you find CRITICAL or MAJOR issues:`,
      `1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress'`,
      `2. Describe each issue clearly so the developer knows what to fix`,
      `3. Do NOT edit any files — report only`,
      ``,
      `If only MINOR issues or no issues: just exit normally (the system will auto-merge).`,
    );
  }
  lines.push(
    ``,
    `Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.`,
    ``,
    `Issue ID: ${issueId}`,
  );
  return lines.join("\n");
}

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

    // Always set workspace back to idle after session exits
    const now = new Date().toISOString();
    await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, workspaceId));
    boardEvents.broadcast(projectId, "workspace_idle");

    // Only run auto-workflow on successful exit (code 0)
    if (exitCode !== 0) return;

    const statuses = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));

    const findStatus = (name: string) => statuses.find(s => s.name === name);

    const prefRows = await db.select().from(preferences);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
    const autoMergeEnabled = prefMap.get("auto_merge") !== "false";

    if (reviewSessionIds.has(sessionId)) {
      // Review session completed
      reviewSessionIds.delete(sessionId);

      // Check if the review agent moved the issue back to "In Progress" (found and fixed critical issues)
      const currentIssueRows = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId)).limit(1);
      const currentStatus = currentIssueRows.length > 0 ? statuses.find(s => s.id === currentIssueRows[0].statusId) : null;

      if (currentStatus?.name === "In Progress") {
        const aiReviewedStatus = findStatus("AI Reviewed");
        if (aiReviewedStatus) {
          await db.update(issues).set({ statusId: aiReviewedStatus.id, updatedAt: now }).where(eq(issues.id, issueId));
          boardEvents.broadcast(projectId, "issue_updated");
        }
      }

      if (autoMergeEnabled) {
        console.log(`[workflow] review session ${sessionId} completed — auto-merging`);
        await autoMerge(workspace, projectId, issueId, findStatus("AI Reviewed")?.id ?? null, now);
      } else {
        console.log(`[workflow] review session ${sessionId} completed — auto-merge disabled, leaving in AI Reviewed`);
        const aiReviewedStatus = findStatus("AI Reviewed");
        if (aiReviewedStatus && currentStatus?.name !== "In Progress") {
          await db.update(issues).set({ statusId: aiReviewedStatus.id, updatedAt: now }).where(eq(issues.id, issueId));
          boardEvents.broadcast(projectId, "issue_updated");
        }
      }
      return;
    }

    // Main agent session completed — check if changes were committed
    let hasCommittedChanges = false;
    if (workspace.workingDir) {
      try {
        hasCommittedChanges = await new Promise<boolean>((resolve) => {
          execFile("git", ["diff", "--quiet", "HEAD"], { cwd: workspace.workingDir! }, (err: Error | null) => {
            // git diff --quiet exits 0 if clean, 1 if dirty
            resolve(!err);
          });
        });
      } catch {
        hasCommittedChanges = false;
      }
    }

    if (hasCommittedChanges) {
      // Agent committed changes — auto-move to In Review and optionally launch review
      console.log(`[workflow] agent session ${sessionId} completed with committed changes — moving to In Review`);
      const inReview = findStatus("In Review");
      if (inReview) {
        await db.update(issues).set({ statusId: inReview.id, updatedAt: now }).where(eq(issues.id, issueId));
      }
      boardEvents.broadcast(projectId, "issue_updated");

      // requiresReview is set at workspace creation time (pre-populated from auto_review global default).
      // null means created before the per-workspace flag existed — fall back to the global auto_review setting.
      // skipAutoReview (set by MCP/CLI) can still override.
      const autoReview = !skipAutoReview && (workspace.requiresReview ?? prefMap.get("auto_review") !== "false");

      if (autoReview) {
        const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
        const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
        const claudeProfile = useMock ? undefined : (prefMap.get("claude_profile") || undefined);
        const reviewArgs = buildReviewArgs(prefMap);
        const autoFix = prefMap.get("review_auto_fix") !== "false";
        const reviewPrompt = buildReviewPrompt(workspace.branch, workspace.baseBranch, issueId, autoFix);

        try {
          // Set workspace to "reviewing" so the board shows "AI Reviewing" badge
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
      const projectRows = await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).limit(1);
      if (projectRows.length > 0) {
        const { repoPath } = projectRows[0];
        await gitService.mergeBranch(repoPath, workspace.branch);
        if (workspace.workingDir) {
          try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
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
    // Still broadcast so board updates
    boardEvents.broadcast(projectId, "workflow_error");
  }
}

// Session manager with onSessionExit callback
const sessionManager = createSessionManager(upgradeWebSocket, {
  onSessionExit: (workspaceId, sessionId, exitCode) => {
    runWorkflowOnExit(workspaceId, sessionId, exitCode).catch((err) => {
      console.error("[fatal] runWorkflowOnExit unhandled:", err);
    });
  },
  onActivity: (projectId, issueId, sessionId, activity) => {
    boardEvents.broadcastActivity(projectId, { issueId, sessionId, activity });
  },
  onLiveStats: (projectId, issueId, model, contextTokens, toolUses) => {
    boardEvents.broadcastLiveStats(projectId, issueId, model, contextTokens, toolUses);
  },
  onTodos: (projectId, issueId, todos) => {
    boardEvents.broadcastTodos(projectId, issueId, todos);
  },
});

// Manual review trigger endpoint
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
    const reviewPrompt = buildReviewPrompt(workspace.branch, workspace.baseBranch, issueId, autoFix);

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

// Mount WebSocket routes
app.get(
  "/ws/sessions/:sessionId",
  sessionManager.wsRoute(),
);
app.get(
  "/ws/board/:projectId",
  boardEvents.wsRoute(),
);

// API routes (with boardEvents for real-time updates)
app.route("/api", createRoutes(db, () => sessionManager, { boardEvents }));

// Session output route
app.route("/api/sessions", createSessionsRoute(db));

// Start server
const port = Number(process.env.PORT) || 3001;

// Run migrations on startup
await migrate(db, { migrationsFolder: "../shared/drizzle" });

// Clean up stale sessions from previous crash/restart
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

console.log(`Server starting on port ${port}...`);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});

// Inject WebSocket handler into the HTTP server
injectWebSocket(server);

// Process lifecycle logging — log but don't exit for recoverable errors
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
  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    console.error("[shutdown] Forced exit after 5s timeout");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
export { sessionManager };
