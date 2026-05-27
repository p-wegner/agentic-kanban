import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { issues, workspaces, sessions, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, desc } from "drizzle-orm";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { randomUUID } from "node:crypto";

const BUTLER_ISSUE_TITLE = "Butler";

function butlerPrefKey(projectId: string) {
  return `butler_workspace_${projectId}`;
}

function buildButlerPrompt(projectName: string, repoPath: string): string {
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  return `You are the project butler for **${projectName}** — a persistent, warm assistant embedded directly in the agentic-kanban board.

Your role:
- Answer questions about the project, codebase, and active work
- Help with quick tasks, analysis, research, and code questions
- Provide a status overview of active agent sessions when asked
- Be concise and helpful; avoid unnecessary preamble

Project location: ${repoPath}
Board API: http://localhost:${serverPort}/api

You have full access to the project files and can use all your standard tools. The kanban board MCP server is also available if connected.

Wait for the user's first message before doing anything.`;
}

/**
 * Creates butler routes mounted under /projects — routes will match paths like
 * /:id/butler, /:id/butler/ensure, /:id/butler/message
 */
export function createButlerRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/projects/:id/butler — return current butler state
  router.get("/:id/butler", async (c) => {
    const projectId = c.req.param("id");

    const workspaceId = await getPreference(butlerPrefKey(projectId), database);
    if (!workspaceId) {
      return c.json({ workspaceId: null, sessionId: null, status: "idle" });
    }

    const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) {
      await setPreference(butlerPrefKey(projectId), "", database);
      return c.json({ workspaceId: null, sessionId: null, status: "idle" });
    }

    const sessionRows = await database
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(1);

    const latestSession = sessionRows[0] ?? null;
    return c.json({
      workspaceId,
      sessionId: latestSession?.id ?? null,
      status: latestSession?.status ?? "idle",
    });
  });

  // POST /api/projects/:id/butler/ensure — create butler workspace if not yet created
  router.post("/:id/butler/ensure", async (c) => {
    const projectId = c.req.param("id");

    const existing = await getPreference(butlerPrefKey(projectId), database);
    if (existing) {
      const wsRows = await database.select().from(workspaces).where(eq(workspaces.id, existing)).limit(1);
      if (wsRows.length > 0) {
        return c.json({ workspaceId: existing, created: false });
      }
    }

    const projectRows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (projectRows.length === 0) {
      return c.json({ error: "Project not found" }, 404);
    }
    const project = projectRows[0];

    const issueId = randomUUID();
    const now = new Date().toISOString();
    const issueRows = await database
      .select({ issueNumber: issues.issueNumber })
      .from(issues)
      .where(eq(issues.projectId, projectId));
    const issueNumber = issueRows.length > 0 ? Math.max(...issueRows.map((r) => r.issueNumber)) + 1 : 1;

    const statusResult = await database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder)
      .limit(1);

    if (statusResult.length === 0) {
      return c.json({ error: "No board statuses found for project" }, 400);
    }

    await database.insert(issues).values({
      id: issueId,
      projectId,
      issueNumber,
      title: BUTLER_ISSUE_TITLE,
      description: "Persistent butler agent for this project.",
      statusId: statusResult[0].id,
      createdAt: now,
      updatedAt: now,
    });

    const customPrompt = buildButlerPrompt(project.name, project.repoPath);
    const ws = await workspaceService.createWorkspace({
      issueId,
      isDirect: true,
      customPrompt,
    });

    await setPreference(butlerPrefKey(projectId), ws.id, database);

    return c.json({ workspaceId: ws.id, sessionId: ws.sessionId ?? null, created: true }, 201);
  });

  // POST /api/projects/:id/butler/message — send a message to the butler
  router.post("/:id/butler/message", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ content: string }>(c);
    if (!body.content?.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const workspaceId = await getPreference(butlerPrefKey(projectId), database);
    if (!workspaceId) {
      return c.json({ error: "Butler not initialized. Call /ensure first." }, 409);
    }

    const result = await workspaceService.sendTurn(workspaceId, body.content);
    if (result.type === "sent") return c.json({ ok: true });
    return c.json({ ok: true, sessionId: result.sessionId, resumed: true });
  });

  // DELETE /api/projects/:id/butler — stop active butler session
  router.delete("/:id/butler", async (c) => {
    const projectId = c.req.param("id");
    const workspaceId = await getPreference(butlerPrefKey(projectId), database);
    if (!workspaceId) return c.json({ ok: true });
    await workspaceService.stopWorkspace(workspaceId);
    return c.json({ ok: true });
  });

  return router;
}
