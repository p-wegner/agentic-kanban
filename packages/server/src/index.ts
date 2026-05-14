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
import { workspaces, issues, projects, projectStatuses, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as gitService from "./services/git.service.js";
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

async function runWorkflowOnExit(workspaceId: string, sessionId: string, exitCode: number | null) {
  try {
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) return;
    const workspace = wsRows[0];

    const issueRows = await db
      .select({ projectId: issues.projectId, id: issues.id })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    if (issueRows.length === 0) return;
    const { projectId, id: issueId } = issueRows[0];

    boardEvents.broadcast(projectId, "session_completed");

    // Only run auto-workflow on successful exit (code 0)
    if (exitCode !== 0) return;

    const statuses = await db
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));

    const findStatus = (name: string) => statuses.find(s => s.name === name);
    const now = new Date().toISOString();

    if (reviewSessionIds.has(sessionId)) {
      // Review session completed — auto-merge and move to Done
      reviewSessionIds.delete(sessionId);
      console.log(`[workflow] review session ${sessionId} completed for workspace ${workspaceId} — auto-merging`);
      await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now);
      return;
    }

    // Main agent session completed — user merges explicitly from the UI
    if (workspace.requiresReview) {
      // Review required — move to "In Review" and launch automated review agent
      console.log(`[workflow] agent session ${sessionId} completed, review required — moving to In Review`);
      const inReview = findStatus("In Review");
      if (inReview) {
        await db.update(issues).set({ statusId: inReview.id, updatedAt: now }).where(eq(issues.id, issueId));
      }
      boardEvents.broadcast(projectId, "issue_updated");

      // Launch automated review session
      const prefRows = await db.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
      const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
      const agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
      const agentArgs = prefMap.get("agent_args") || undefined;

      const reviewPrompt = [
        `You are a code reviewer. Review the changes on branch '${workspace.branch}'.`,
        `Run 'git diff ${workspace.baseBranch ?? "HEAD"}' to see the diff.`,
        `Provide a concise review covering: correctness, code quality, and potential issues.`,
        `When finished, use the update_issue MCP tool to move this issue to 'Done' status if ready to merge, or describe what needs to change.`,
        `Issue ID: ${issueId}`,
      ].join("\n");

      try {
        const reviewSessionId = await sessionManager.startSession(workspaceId, reviewPrompt, agentCommand, agentArgs);
        reviewSessionIds.add(reviewSessionId);
        console.log(`[workflow] launched review session ${reviewSessionId} for workspace ${workspaceId}`);
      } catch (err) {
        console.error("[workflow] Failed to launch review session:", err);
      }
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
    runWorkflowOnExit(workspaceId, sessionId, exitCode);
  },
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

console.log(`Server starting on port ${port}...`);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});

// Inject WebSocket handler into the HTTP server
injectWebSocket(server);

export default app;
export { sessionManager };
