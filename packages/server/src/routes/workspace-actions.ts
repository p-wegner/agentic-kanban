import { createHash } from "node:crypto";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createWorkspaceServicesControlService } from "../services/workspace-services-control.service.js";
import { createBisectService, type BisectScope } from "../services/bisect.service.js";
import { createSessionArtifactsService } from "../services/session-artifacts.service.js";
import { getWorkspaceTimeline } from "../services/workspace-timeline.service.js";
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
  const artifactsService = createSessionArtifactsService({ database });
  const servicesControl = createWorkspaceServicesControlService({
    database,
    boardEvents: options?.boardEvents,
  });

  // ── Per-workspace Docker service-stack lifecycle controls (#92) ──────────────
  // Reuse the existing compose/port engine — the compose project name + allocated
  // host ports are preserved across start/stop/restart (no reallocation).

  // POST /api/workspaces/:id/services/up — start (or, with ?recreate=true, rebuild) the
  // stack; (re)provisions a deferred/errored/never-run stack (the "Retry" control).
  router.post("/:id/services/up", async (c) => {
    const id = c.req.param("id");
    const recreate = c.req.query("recreate") === "true";
    const serviceState = await servicesControl.up(id, { recreate });
    return c.json({ serviceState });
  });

  // POST /api/workspaces/:id/services/down — stop the stack (containers removed, named
  // volumes kept so a subsequent start finds its data intact).
  router.post("/:id/services/down", async (c) => {
    const id = c.req.param("id");
    const serviceState = await servicesControl.down(id);
    return c.json({ serviceState });
  });

  // POST /api/workspaces/:id/services/restart — bounce the running containers.
  router.post("/:id/services/restart", async (c) => {
    const id = c.req.param("id");
    const serviceState = await servicesControl.restart(id);
    return c.json({ serviceState });
  });

  // GET /api/workspaces/:id/services/logs?tail=N — a bounded, non-following log tail.
  router.get("/:id/services/logs", async (c) => {
    const id = c.req.param("id");
    const tailRaw = Number(c.req.query("tail"));
    const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? Math.min(Math.floor(tailRaw), 2000) : 200;
    const result = await servicesControl.logs(id, tail);
    return c.json(result);
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
    const body = await parseJsonBody<{ content?: string }>(c);
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

  // POST /api/workspaces/:id/quarantine — stop session + move issue back to In Progress
  router.post("/:id/quarantine", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.quarantineWorkspace(id));
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
    const result = await workspaceService.getWorkspaceDiff(id);
    const body = JSON.stringify(result);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  });

  // POST /api/workspaces/:id/merge
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.mergeWorkspaceDeduped(id));
  });

  // GET /api/workspaces/:id/already-merged-status — check if branch is already merged without modifying state
  router.get("/:id/already-merged-status", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.checkAlreadyMerged(id));
  });

  // GET /api/workspaces/:id/repo-merge-status — per-repo (leading + siblings) merge status (#70)
  router.get("/:id/repo-merge-status", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getRepoMergeStatus(id));
  });

  // POST /api/workspaces/:id/reconcile-as-done — close a workspace whose branch is already on master
  router.post("/:id/reconcile-as-done", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.reconcileAlreadyMerged(id), 200);
  });

  // GET /api/workspaces/:id/github-handoff-draft
  router.get("/:id/github-handoff-draft", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.getLatestGithubHandoffDraft(id) ?? { artifactId: null, content: null, createdAt: null });
  });

  // POST /api/workspaces/:id/github-handoff-draft
  router.post("/:id/github-handoff-draft", async (c) => {
    const id = c.req.param("id");
    return c.json(await workspaceService.generateGithubHandoffDraft(id), 201);
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
    const body = await parseJsonBody<{ filePath: string; body: string; lineNumOld?: number | null; lineNumNew?: number | null; side?: string }>(c);
    if (!body.filePath || !body.body) return c.json({ error: "filePath and body are required" }, 400);
    return c.json(await workspaceService.createComment(id, body), 201);
  });

  // PATCH /api/workspaces/:id/comments/:commentId
  router.patch("/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await parseJsonBody<{ body?: string }>(c);
    if (!body.body) return c.json({ error: "body is required" }, 400);
    return c.json(await workspaceService.updateComment(id, commentId, body.body));
  });

  // PATCH /api/workspaces/:id/comments/:commentId/resolve — toggle resolved state
  router.patch("/:id/comments/:commentId/resolve", async (c) => {
    const id = c.req.param("id");
    const commentId = c.req.param("commentId");
    const body = await parseJsonBody(c);
    if (typeof body.resolved !== "boolean") return c.json({ error: "resolved (boolean) is required" }, 400);
    return c.json(await workspaceService.resolveComment(id, commentId, body.resolved));
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

  // DELETE /api/workspaces/:id/stale-worktree — safely remove a stale worktree directory
  router.delete("/:id/stale-worktree", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.removeStaleWorktree(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  // POST /api/workspaces/:id/retry-cleanup — retry worktree cleanup for a workspace with a pending warning
  router.post("/:id/retry-cleanup", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.retryCleanup(id);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ success: true });
  });

  // GET /api/workspaces/:id/visual-proof — list DB artifacts (visual proof) scoped to this workspace
  router.get("/:id/visual-proof", async (c) => {
    const id = c.req.param("id");
    const rows = await artifactsService.listVisualProof(id);
    if (rows === null) return c.json({ error: "Workspace not found" }, 404);
    return c.json(rows);
  });

  // GET /api/workspaces/:id/artifacts — list recognized artifacts in workspace directory
  router.get("/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    const artifacts = await artifactsService.listArtifacts(id);
    return c.json(artifacts);
  });

  // GET /api/workspaces/:id/artifacts-file — read a single artifact by ?path= query param
  router.get("/:id/artifacts-file", async (c) => {
    const id = c.req.param("id");
    const artifactPath = c.req.query("path");
    if (!artifactPath) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    const ext = artifactPath.split(".").pop()?.toLowerCase() ?? "";
    const imageExts = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];
    if (imageExts.includes(ext)) {
      const result = await artifactsService.readImageArtifact(id, artifactPath);
      return new Response(result.buffer, {
        headers: {
          "Content-Type": result.mimeType,
          "Cache-Control": "no-cache",
        },
      });
    }
    const result = await artifactsService.readTextArtifact(id, artifactPath);
    return c.json(result);
  });

  // GET /api/workspaces/:id/handoff-bundle — export a compact handoff bundle (JSON or Markdown)
  router.get("/:id/handoff-bundle", async (c) => {
    const id = c.req.param("id");
    const format = c.req.query("format");
    const bundle = await workspaceService.exportHandoffBundle(id);
    if (format === "markdown") {
      const md = workspaceService.renderHandoffBundleAsMarkdown(bundle);
      return new Response(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="handoff-${id.slice(0, 8)}.md"`,
        },
      });
    }
    return c.json(bundle);
  });

  // GET /api/workspaces/:id/timeline — session failure timeline with restart decisions
  router.get("/:id/timeline", async (c) => {
    const id = c.req.param("id");
    const timeline = await getWorkspaceTimeline(id, database);
    return c.json(timeline);
  });

  return router;
}
