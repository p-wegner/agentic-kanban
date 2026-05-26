import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService, WorkspaceError } from "../services/workspace.service.js";
import type { CreateWorkspaceInput } from "../services/workspace.service.js";
import { getWorkspaceDetails } from "../repositories/workspace.repository.js";

export function createWorkspacesRoute(
  database: Database = db,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // POST /api/workspaces — create workspace with worktree + auto-launch agent
  router.post("/", async (c) => {
    const body = await c.req.json();
    const isDirect = body.isDirect === true;
    if (!body.issueId || (!body.branch && !isDirect)) {
      return c.json({ error: "issueId is required; branch is required unless isDirect is true" }, 400);
    }

    try {
      const result = await workspaceService.createWorkspace({
        issueId: body.issueId,
        branch: body.branch,
        isDirect,
        baseBranch: body.baseBranch,
        requiresReview: body.requiresReview === true,
        thoroughReview: body.thoroughReview === true,
        planMode: body.planMode === true,
        includeVisualProof: body.includeVisualProof === true,
        skipSetup: body.skipSetup === true,
        customPrompt: body.customPrompt,
        skillId: body.skillId,
        profile: body.profile,
        claudeProfile: body.claudeProfile,
      } satisfies CreateWorkspaceInput);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const status = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, status);
      }
      throw err;
    }
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const details = await getWorkspaceDetails(id, database);
    if (!details) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(details);
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
    if (body.planMode !== undefined) updates.planMode = body.planMode === true;

    await database.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return c.json({ id });
  });

  // POST /api/workspaces/:id/ready-for-merge — mark workspace as reviewed and ready to merge
  router.post("/:id/ready-for-merge", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.markReadyForMerge(id);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // DELETE /api/workspaces/:id — cascade delete sessions and their messages
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await workspaceService.deleteWorkspace(id);
    return c.json({ success: true });
  });

  return router;
}

export const workspacesRoute = createWorkspacesRoute();
