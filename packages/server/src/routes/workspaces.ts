import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import type { CreateWorkspaceInput } from "../services/workspace.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";

export function createWorkspacesRoute(
  database: Database,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // POST /api/workspaces — create workspace with worktree + auto-launch agent
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const isDirect = body.isDirect === true;
    if (!body.issueId || (!body.branch && !isDirect)) {
      return c.json({ error: "issueId is required; branch is required unless isDirect is true" }, 400);
    }

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
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const details = await workspaceService.getWorkspace(id);
    if (!details) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(details);
  });

  // PATCH /api/workspaces/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await workspaceService.updateWorkspace(id, body);
    return c.json(result);
  });

  // POST /api/workspaces/:id/ready-for-merge — mark workspace as reviewed and ready to merge
  router.post("/:id/ready-for-merge", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.markReadyForMerge(id);
    return c.json(result);
  });

  // DELETE /api/workspaces/:id — cascade delete sessions and their messages
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await workspaceService.deleteWorkspace(id);
    return c.json({ success: true });
  });

  return router;
}
