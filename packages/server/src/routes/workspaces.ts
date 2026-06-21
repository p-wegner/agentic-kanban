import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import type { CreateWorkspaceInput } from "../services/workspace.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import {
  getProviderMixRows,
  getCostOverTimeRows,
  getScorecardScores,
  listWorkspacesSlim,
} from "../repositories/workspace.repository.js";
import {
  aggregateProviderMix,
  aggregateCostOverTime,
  bucketScorecardScores,
} from "../lib/workspace-stats.js";
import { clampDays, cutoffDayFor, subDays, buildDateAxis } from "../lib/analytics-window.js";

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

  // GET /api/workspaces/provider-mix?projectId=&days= — workspaces grouped by provider+profile per day
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/provider-mix", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 14);
    const now = new Date();

    const rows = await getProviderMixRows(projectId, cutoffDayFor(now, days), database);
    const dates = buildDateAxis(subDays(now, days - 1), now);
    return c.json(aggregateProviderMix(rows, dates));
  });

  // GET /api/workspaces/cost-over-time?projectId=&days= — estimated token cost per provider per day
  // Complements provider-mix (share of work) by showing the cost *trend* over time. Cost is read
  // from each session's persisted `stats.totalCostUsd`; the provider comes from the session's
  // workspace. Must be registered BEFORE /:id to avoid being matched as an ID param.
  router.get("/cost-over-time", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 30);

    // Start-of-UTC-day cutoff so the day buckets (ISO date keys) line up with the filter.
    // (Deliberately UTC-anchored, unlike the local-day analytics-window helpers used
    // elsewhere — cost buckets key on UTC ISO days, so the cutoff must match.)
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days + 1);
    cutoffDate.setUTCHours(0, 0, 0, 0);
    const cutoffIso = cutoffDate.toISOString();

    const rows = await getCostOverTimeRows(projectId, cutoffIso, database);

    // Build a continuous UTC-day axis from the cutoff through today.
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    return c.json(aggregateCostOverTime(rows, dates));
  });

  // GET /api/workspaces/scorecard-distribution?projectId=&days= — scorecard score histogram (5 buckets: 0-20, 20-40, 40-60, 60-80, 80-100)
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/scorecard-distribution", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 90);

    const rows = await getScorecardScores(projectId, cutoffDayFor(new Date(), days), database);
    return c.json(bucketScorecardScores(rows));
  });

  // GET /api/workspaces/stale-worktrees — list closed workspaces with directories still on disk
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/stale-worktrees", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const staleWorktrees = await workspaceService.listStaleWorktrees(projectId);
    return c.json(staleWorktrees);
  });

  // GET /api/workspaces/cleanup-warnings — list closed workspaces with pending cleanup warnings
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/cleanup-warnings", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const warnings = await workspaceService.listCleanupWarnings(projectId);
    return c.json(warnings);
  });

  // POST /api/workspaces/preview — dry-run preview (read-only, no side effects)
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.post("/preview", async (c) => {
    const body = await parseJsonBody(c);
    if (!body.issueId) {
      return c.json({ error: "issueId is required" }, 400);
    }

    const result = await workspaceService.computeLaunchPreview({
      issueId: body.issueId,
      branch: body.branch,
      isDirect: body.isDirect === true,
      baseBranch: body.baseBranch,
      requiresReview: body.requiresReview === true,
      thoroughReview: body.thoroughReview === true,
      planMode: body.planMode,
      tddMode: body.tddMode === true,
      includeVisualProof: body.includeVisualProof === true,
      skipSetup: body.skipSetup === true,
      customPrompt: body.customPrompt,
      clarifications: body.clarifications,
      skillId: body.skillId,
      skillName: body.skillName,
      profile: body.profile,
      claudeProfile: body.claudeProfile,
      model: body.model,
      skipContextPacker: body.skipContextPacker === true,
    } satisfies CreateWorkspaceInput);
    return c.json(result);
  });

  // GET /api/workspaces?projectId= — flat project-scoped workspace list (slim: id/status/readyForMerge/issueId/branch/provider)
  // GET /api/workspaces?issueId= — workspaces for a single issue (same shape, no join needed)
  // Optional: status=active,idle (comma-separated), limit=N, offset=N
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const issueId = c.req.query("issueId");

    if (!projectId && !issueId) {
      return c.json({ error: "projectId or issueId required" }, 400);
    }

    const statusParam = c.req.query("status");
    const statusFilter = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limitParsed = limitParam ? parseInt(limitParam, 10) : NaN;
    const offsetParsed = offsetParam ? parseInt(offsetParam, 10) : NaN;
    const limit = !isNaN(limitParsed) ? Math.max(1, limitParsed) : undefined;
    const offset = !isNaN(offsetParsed) ? Math.max(0, offsetParsed) : undefined;

    // Slim projection lives in the repository (listWorkspacesSlim). issueId takes
    // precedence (no join); otherwise scope by projectId through the issues join.
    // The projection surfaces model + mergedAt/isDirect alongside provider so an
    // agent reading the list API sees real model ids (#819) and merge state (#827).
    const rows = await listWorkspacesSlim(
      { issueId: issueId ?? undefined, projectId: projectId ?? undefined, statusFilter, limit, offset },
      database,
    );
    return c.json(rows);
  });

  // POST /api/workspaces — create workspace with worktree + auto-launch agent
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const isDirect = body.isDirect === true;
    if (!body.issueId) {
      return c.json({ error: "issueId is required" }, 400);
    }

    const result = await workspaceService.createWorkspace({
      issueId: body.issueId,
      branch: body.branch,
      isDirect,
      baseBranch: body.baseBranch,
      requiresReview: body.requiresReview === true,
      thoroughReview: body.thoroughReview === true,
      planMode: body.planMode === true,
      tddMode: body.tddMode === true,
      includeVisualProof: body.includeVisualProof === true,
      skipSetup: body.skipSetup === true,
      customPrompt: body.customPrompt,
      clarifications: body.clarifications,
      skillId: body.skillId,
      skillName: body.skillName,
      profile: body.profile,
      claudeProfile: body.claudeProfile,
      model: body.model,
      skipContextPacker: body.skipContextPacker === true,
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

  // POST /api/workspaces/:id/close — close without merging (abandoned or already-merged work)
  router.post("/:id/close", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.closeWorkspace(id);
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
