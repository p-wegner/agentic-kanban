import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, issues, projects, preferences, sessions, sessionMessages, diffComments, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../services/git.service.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
// Resolve tsx from server's node_modules so the mock agent works from any CWD (e.g. worktrees)
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

export function createWorkspacesRoute(
  database: Database = db,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces — create workspace with worktree + auto-launch agent
  router.post("/", async (c) => {
    const body = await c.req.json();
    const isDirect = body.isDirect === true;
    if (!body.issueId || (!body.branch && !isDirect)) {
      return c.json({ error: "issueId is required; branch is required unless isDirect is true" }, 400);
    }

    const requiresReview = body.requiresReview === true;
    const planMode = body.planMode === true;
    const now = new Date().toISOString();
    const id = randomUUID();
    let sessionId: string | undefined;
    let worktreePath: string | null = null;
    let baseBranch: string | null = null;
    let branch: string = body.branch;

    try {
      // Resolve issue → project to get repoPath and defaultBranch
      const issueRows = await database
        .select({ projectId: issues.projectId, title: issues.title, description: issues.description })
        .from(issues)
        .where(eq(issues.id, body.issueId))
        .limit(1);

      if (issueRows.length === 0) {
        return c.json({ error: "Issue not found" }, 404);
      }

      const issue = issueRows[0];

      const projectRows = await database
        .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, issue.projectId))
        .limit(1);

      if (projectRows.length === 0) {
        return c.json({ error: "Project not found" }, 404);
      }

      const project = projectRows[0];

      if (isDirect) {
        // Direct workspace: use main checkout, auto-detect branch
        branch = await gitService.getCurrentBranch(project.repoPath);
        worktreePath = project.repoPath;
        baseBranch = null;
      } else {
        // Normal workspace: create worktree
        baseBranch = body.baseBranch || project.defaultBranch;
        worktreePath = await gitService.createWorktree(project.repoPath, branch, baseBranch ?? undefined);
      }

      // Build prompt from issue title + description
      let agentPrompt = issue.title;
      if (issue.description) {
        agentPrompt += `\n\n${issue.description}`;
      }

      // Read agent settings from preferences
      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      let agentCommand: string | undefined;
      const useMock = prefMap.get("mock_agent") === "true" || process.env.MOCK_AGENT === "1";
      if (useMock) {
        agentCommand = MOCK_AGENT_COMMAND;
      } else {
        agentCommand = prefMap.get("agent_command") || undefined;
      }
      const skipPerms = prefMap.get("skip_permissions") === "true";
      const baseArgs = prefMap.get("agent_args") || "";
      const agentArgs = skipPerms
        ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
        : (baseArgs || undefined);
      const claudeProfile = prefMap.get("claude_profile") || undefined;

      // Insert DB record with workingDir and baseBranch
      await database.insert(workspaces).values({
        id,
        issueId: body.issueId,
        branch,
        workingDir: worktreePath,
        baseBranch,
        isDirect,
        requiresReview,
        planMode,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // Auto-move issue to "In Progress" when workspace is created
      try {
        const statuses = await database
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, issue.projectId));
        const inProgress = statuses.find(s => s.name === "In Progress");
        if (inProgress) {
          await database
            .update(issues)
            .set({ statusId: inProgress.id, updatedAt: now, statusChangedAt: now })
            .where(eq(issues.id, body.issueId));
        }
      } catch (err) {
        console.warn("[workspaces] Failed to move issue to In Progress:", err);
      }

      // Auto-launch agent if sessionManager is available
      if (getSessionManager) {
        const truncatedPrompt = agentPrompt.length > 80 ? agentPrompt.slice(0, 80) + "..." : agentPrompt;
        console.log(`[workspaces] auto-launch: workspaceId=${id} branch=${branch} isDirect=${isDirect} prompt="${truncatedPrompt}" agentCommand=${agentCommand ?? "default"}`);
        sessionId = await getSessionManager().startSession(id, agentPrompt, agentCommand, agentArgs, undefined, claudeProfile, undefined, undefined, planMode);
      }

      // Broadcast board event
      if (options?.boardEvents) {
        options.boardEvents.broadcast(issue.projectId, "workspace_created");
      }

      return c.json(
        {
          id,
          issueId: body.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          planMode,
          status: "active",
          sessionId,
          createdAt: now,
          updatedAt: now,
        },
        201,
      );
    } catch (err) {
      // If worktree was created but launch failed, still return workspace with error info
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[workspaces] create failed: ${errorMsg}`);

      // Try to save workspace record even if launch failed
      try {
        await database.insert(workspaces).values({
          id,
          issueId: body.issueId,
          branch,
          workingDir: worktreePath,
          baseBranch,
          isDirect,
          requiresReview,
          planMode,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        // DB insert may fail if worktree creation itself failed — that's fine
      }

      return c.json(
        { id, issueId: body.issueId, branch, workingDir: worktreePath, baseBranch, isDirect, planMode, status: "active", error: errorMsg },
        201,
      );
    }
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");

    const result = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        planMode: workspaces.planMode,
        status: workspaces.status,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        issueTitle: issues.title,
        issuePriority: issues.priority,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, id));

    if (result.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const row = result[0];
    return c.json({
      id: row.id,
      issueId: row.issueId,
      branch: row.branch,
      workingDir: row.workingDir,
      baseBranch: row.baseBranch,
      isDirect: row.isDirect,
      planMode: row.planMode,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      issue: { title: row.issueTitle, priority: row.issuePriority },
    });
  });

  // PATCH /api/workspaces/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const validStatuses = ["active", "reviewing", "idle", "closed"];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: "Invalid status. Must be active, reviewing, idle, or closed" }, 400);
    }

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) updates.status = body.status;
    if (body.workingDir !== undefined) updates.workingDir = body.workingDir;

    await database.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return c.json({ id });
  });

  // DELETE /api/workspaces/:id — cascade delete sessions and their messages
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Get session IDs for this workspace
    const wsSessions = await database
      .select({ id: sessions.id, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.workspaceId, id));

    // Kill any running agents before deleting sessions to prevent FK errors
    // from in-flight broadcast callbacks trying to insert session_messages after deletion
    if (getSessionManager && wsSessions.some(s => s.status === "running")) {
      for (const s of wsSessions) {
        if (s.status === "running") {
          await getSessionManager().stopSession(s.id).catch(() => {});
        }
      }
    }

    // Delete diff comments, session messages (cascade via FK on delete), sessions, workspace
    await database.delete(diffComments).where(eq(diffComments.workspaceId, id));
    if (wsSessions.length > 0) {
      const sessionIds = wsSessions.map(s => s.id);
      await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, sessionIds));
    }
    await database.delete(sessions).where(eq(sessions.workspaceId, id));
    await database.delete(workspaces).where(eq(workspaces.id, id));
    return c.json({ success: true });
  });

  return router;
}

export const workspacesRoute = createWorkspacesRoute();
