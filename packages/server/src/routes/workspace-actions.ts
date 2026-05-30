import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createBisectService, type BisectScope } from "../services/bisect.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = createRouter();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const bisectService = createBisectService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // POST /api/workspaces/:id/setup
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.setupWorkspace(id));
  });

  // POST /api/workspaces/:id/terminal
  router.post("/:id/terminal", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.openTerminal(id);
    return c.json({ ok: true, ...result });
  });

  // POST /api/workspaces/:id/launch
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody(c);
    return c.json(await workspaceService.launchSession(id, body), 201);
  });

  // POST /api/workspaces/:id/turn
  router.post("/:id/turn", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.content) return c.json({ error: "content is required" }, 400);
    const result = await workspaceService.sendTurn(id, body.content);
    if (result.type === "sent") return c.json({ ok: true });
    return c.json({ sessionId: result.sessionId, resumed: true }, 201);
  });

  // POST /api/workspaces/:id/stop
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    console.log(`[workspace-actions] stop: workspaceId=${id}`);
    return c.json(await workspaceService.stopWorkspace(id));
  });

  // POST /api/workspaces/:id/implement-plan
  router.post("/:id/implement-plan", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ planContent?: string }>(c);
    return c.json(await workspaceService.implementPlan(id, body.planContent), 201);
  });

  // GET /api/workspaces/:id/plan
  router.get("/:id/plan", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getPlanContent(id));
  });

  // POST /api/workspaces/:id/reject-plan
  router.post("/:id/reject-plan", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.feedback) return c.json({ error: "feedback is required" }, 400);
    return c.json(await workspaceService.rejectPlan(id, body.feedback as string), 201);
  });

  // POST /api/workspaces/:id/bisect
  router.post("/:id/bisect", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ scope?: BisectScope }>(c);
    const scope = body.scope === "full" ? "full" : "related";
    return c.json(await bisectService.startBisect(id, scope), 201);
  });

  // GET /api/workspaces/:id/latest-commit
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getLatestCommit(id));
  });

  // GET /api/workspaces/:id/diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getWorkspaceDiff(id));
  });

  // POST /api/workspaces/:id/merge
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.mergeWorkspace(id));
  });

  // GET /api/workspaces/:id/conflicts
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getConflicts(id));
  });

  // POST /api/workspaces/:id/update-base
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const mode = body.mode === "merge" ? "merge" as const : "rebase" as const;
    return c.json(await workspaceService.updateBase(id, mode));
  });

  // POST /api/workspaces/:id/abort-rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.abortRebase(id));
  });

  // POST /api/workspaces/:id/resolve-conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.resolveConflicts(id);
    options?.fixAndMergeSessionIds?.add(result.sessionId);
    return c.json(result, 201);
  });

  // POST /api/workspaces/:id/fix-and-merge
  router.post("/:id/fix-and-merge", async (c) => {
    const id = c.req.param("id");
    const body = await parseOptionalJsonBody<{ mergeError?: string }>(c);
    const result = await workspaceService.fixAndMerge(id, body.mergeError);
    options?.fixAndMergeSessionIds?.add(result.sessionId);
    return c.json(result, 201);
  });

  // GET /api/workspaces/:id/comments
  router.get("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");
    return c.json(await workspaceService.listComments(id, filePath));
  });

  // POST /api/workspaces/:id/comments
  router.post("/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.filePath || !body.body) return c.json({ error: "filePath and body are required" }, 400);
    return c.json(await workspaceService.createComment(id, body), 201);
  });

  // PATCH /api/workspaces/:id/comments/:commentId
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await parseJsonBody(c);
    if (!body.body) return c.json({ error: "body is required" }, 400);
    return c.json(await workspaceService.updateComment(id, commentId, body.body));
  });

  // DELETE /api/workspaces/:id/comments/:commentId
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    await workspaceService.deleteComment(id, commentId);
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getSessions(id));
  });

  // POST /api/workspaces/:id/open-editor
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");
    await workspaceService.openEditor(id);
    return c.json({ ok: true });
  });

  // GET /api/workspaces/:id/scorecard
  router.get("/:id/scorecard", async (c) => {
    const id = c.req.param("id");
    const { getScorecardFromDb, computeScorecard } = await import("../services/workspace-scorecard.service.js");
    let scorecard = await getScorecardFromDb(id, database);
    if (!scorecard) {
      scorecard = await computeScorecard(id, database);
    }
    if (!scorecard) return c.json({ error: "Scorecard not available" }, 404);
    return c.json(scorecard);
  });

  // POST /api/workspaces/:id/scorecard/refresh
  router.post("/:id/scorecard/refresh", async (c) => {
    const id = c.req.param("id");
    const { computeScorecard } = await import("../services/workspace-scorecard.service.js");
    const scorecard = await computeScorecard(id, database);
    if (!scorecard) return c.json({ error: "Scorecard not available" }, 404);
    return c.json(scorecard);
  });

  return router;
}
