import { Hono } from "hono";
import { db } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService, WorkspaceError } from "../services/workspace.service.js";

function wsStatus(err: WorkspaceError): 404 | 409 | 400 {
  if (err.code === "NOT_FOUND") return 404;
  if (err.code === "CONFLICT") return 409;
  return 400;
}

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = new Hono();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // POST /api/workspaces/:id/setup
  router.post("/:id/setup", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.setupWorkspace(id));
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, wsStatus(err) === 404 ? 404 : 500);
      }
      return c.json({ error: `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/terminal
  router.post("/:id/terminal", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.openTerminal(id);
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Terminal launch failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/launch
  router.post("/:id/launch", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty body is fine */ }
    try {
      return c.json(await workspaceService.launchSession(id, body), 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Launch failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/turn
  router.post("/:id/turn", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    if (!body.content) return c.json({ error: "content is required" }, 400);
    try {
      const result = await workspaceService.sendTurn(id, body.content);
      if (result.type === "sent") return c.json({ ok: true });
      return c.json({ sessionId: result.sessionId, resumed: true }, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      throw err;
    }
  });

  // POST /api/workspaces/:id/stop
  router.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    console.log(`[workspace-actions] stop: workspaceId=${id}`);
    try {
      return c.json(await workspaceService.stopWorkspace(id));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Stop failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/implement-plan
  router.post("/:id/implement-plan", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.implementPlan(id), 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Implement-plan failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/latest-commit
  router.get("/:id/latest-commit", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.getLatestCommit(id));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // GET /api/workspaces/:id/diff
  router.get("/:id/diff", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.getWorkspaceDiff(id));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Diff failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/merge
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.mergeWorkspace(id));
    } catch (err) {
      if (err instanceof WorkspaceError) {
        if (err.data?.conflictingFiles) {
          return c.json({ error: "Merge conflicts detected", conflictingFiles: err.data.conflictingFiles }, 409);
        }
        return c.json({ error: err.message }, wsStatus(err) === 404 ? 404 : 500);
      }
      return c.json({ error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // GET /api/workspaces/:id/conflicts
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.getConflicts(id));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, 404);
      return c.json({ error: `Conflict detection failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/update-base
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const mode = body.mode === "merge" ? "merge" as const : "rebase" as const;
    try {
      return c.json(await workspaceService.updateBase(id, mode));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Update base failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/abort-rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    try {
      return c.json(await workspaceService.abortRebase(id));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Abort rebase failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/resolve-conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await workspaceService.resolveConflicts(id);
      options?.fixAndMergeSessionIds?.add(result.sessionId);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Resolve conflicts failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/fix-and-merge
  router.post("/:id/fix-and-merge", async (c) => {
    const id = c.req.param("id");
    const body: { mergeError?: string } = await c.req.json<{ mergeError?: string }>().catch(() => ({}));
    try {
      const result = await workspaceService.fixAndMerge(id, body.mergeError);
      options?.fixAndMergeSessionIds?.add(result.sessionId);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Fix-and-merge failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
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
    const body = await c.req.json();
    if (!body.filePath || !body.body) return c.json({ error: "filePath and body are required" }, 400);
    try {
      return c.json(await workspaceService.createComment(id, body), 201);
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      throw err;
    }
  });

  // PATCH /api/workspaces/:id/comments/:commentId
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await c.req.json();
    if (!body.body) return c.json({ error: "body is required" }, 400);
    try {
      return c.json(await workspaceService.updateComment(id, commentId, body.body));
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      throw err;
    }
  });

  // DELETE /api/workspaces/:id/comments/:commentId
  router.delete("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    try {
      await workspaceService.deleteComment(id, commentId);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      throw err;
    }
  });

  // GET /api/workspaces/:id/sessions
  router.get("/:id/sessions", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getSessions(id));
  });

  // POST /api/workspaces/:id/open-editor
  router.post("/:id/open-editor", async (c) => {
    const id = c.req.param("id");
    try {
      await workspaceService.openEditor(id);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof WorkspaceError) return c.json({ error: err.message }, wsStatus(err));
      return c.json({ error: `Failed to open editor: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  return router;
}
