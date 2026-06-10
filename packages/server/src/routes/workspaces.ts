import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import type { CreateWorkspaceInput } from "../services/workspace.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { workspaces, issues, sessions } from "@agentic-kanban/shared/schema";

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
    const daysRaw = parseInt(c.req.query("days") ?? "14", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 14 : daysRaw, 1), 365);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffDay = cutoffDate.toISOString().slice(0, 10);

    const rows = await database
      .select({
        provider: workspaces.provider,
        claudeProfile: workspaces.claudeProfile,
        createdAt: workspaces.createdAt,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(
        and(
          eq(issues.projectId, projectId),
          gte(workspaces.createdAt, cutoffDay)
        )
      );

    // Build date axis
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // Collect all provider+profile combos
    const seriesSet = new Set<string>();
    for (const r of rows) {
      const key = r.provider ?? "unknown";
      seriesSet.add(key);
    }
    const series = [...seriesSet].sort();

    // Count per day per series
    const counts: Record<string, Record<string, number>> = {};
    for (const date of dates) {
      counts[date] = {};
      for (const s of series) counts[date][s] = 0;
    }
    for (const r of rows) {
      if (!r.createdAt) continue;
      const day = r.createdAt.slice(0, 10);
      if (!counts[day]) continue;
      const key = r.provider ?? "unknown";
      counts[day][key] = (counts[day][key] ?? 0) + 1;
    }

    const points = dates.map((date) => ({ date, counts: counts[date] ?? {} }));
    return c.json({ series, points });
  });

  // GET /api/workspaces/cost-over-time?projectId=&days= — estimated token cost per provider per day
  // Complements provider-mix (share of work) by showing the cost *trend* over time. Cost is read
  // from each session's persisted `stats.totalCostUsd`; the provider comes from the session's
  // workspace. Must be registered BEFORE /:id to avoid being matched as an ID param.
  router.get("/cost-over-time", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const daysRaw = parseInt(c.req.query("days") ?? "30", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 30 : daysRaw, 1), 365);

    // Start-of-UTC-day cutoff so the day buckets (ISO date keys) line up with the filter.
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days + 1);
    cutoffDate.setUTCHours(0, 0, 0, 0);
    const cutoffIso = cutoffDate.toISOString();

    const rows = await database
      .select({
        provider: workspaces.provider,
        startedAt: sessions.startedAt,
        stats: sessions.stats,
      })
      .from(sessions)
      .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(
        and(
          eq(issues.projectId, projectId),
          gte(sessions.startedAt, cutoffIso),
        )
      );

    // Build a continuous UTC-day axis from the cutoff through today.
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // Collect provider keys present in the window (stable, sorted).
    const seriesSet = new Set<string>();
    for (const r of rows) {
      seriesSet.add(r.provider ?? "unknown");
    }
    const series = [...seriesSet].sort();

    // Sum cost per day per provider.
    const costs: Record<string, Record<string, number>> = {};
    for (const date of dates) {
      costs[date] = {};
      for (const s of series) costs[date][s] = 0;
    }
    for (const r of rows) {
      if (!r.startedAt || !r.stats) continue;
      let sessionCost = 0;
      try {
        const parsed = JSON.parse(r.stats) as { totalCostUsd?: unknown };
        const value = Number(parsed.totalCostUsd ?? 0);
        if (Number.isFinite(value)) sessionCost = value;
      } catch {
        continue;
      }
      if (sessionCost === 0) continue;
      const day = r.startedAt.slice(0, 10);
      if (!costs[day]) continue; // session outside the axis window (shouldn't happen post-filter)
      const key = r.provider ?? "unknown";
      costs[day][key] = (costs[day][key] ?? 0) + sessionCost;
    }

    const points = dates.map((date) => ({ date, costs: costs[date] ?? {} }));
    return c.json({ series, points });
  });

  // GET /api/workspaces/scorecard-distribution?projectId=&days= — scorecard score histogram (5 buckets: 0-20, 20-40, 40-60, 60-80, 80-100)
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/scorecard-distribution", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const daysRaw = parseInt(c.req.query("days") ?? "90", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 90 : daysRaw, 1), 365);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffDay = cutoffDate.toISOString().slice(0, 10);

    const rows = await database
      .select({ score: workspaces.scorecardScore })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(
        and(
          eq(issues.projectId, projectId),
          gte(workspaces.createdAt, cutoffDay),
          isNotNull(workspaces.scorecardScore)
        )
      );

    const buckets = [
      { range: "0-20", min: 0, max: 20, count: 0 },
      { range: "20-40", min: 20, max: 40, count: 0 },
      { range: "40-60", min: 40, max: 60, count: 0 },
      { range: "60-80", min: 60, max: 80, count: 0 },
      { range: "80-100", min: 80, max: 100, count: 0 },
    ];

    for (const row of rows) {
      const score = row.score ?? 0;
      const idx = score >= 100 ? 4 : Math.min(Math.floor(score / 20), 4);
      buckets[idx].count++;
    }

    return c.json({ buckets: buckets.map(({ range, count }) => ({ range, count })), total: rows.length });
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

    const selectShape = {
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      readyForMerge: workspaces.readyForMerge,
      provider: workspaces.provider,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    };

    if (issueId) {
      const conditions = [eq(workspaces.issueId, issueId)];
      if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
      let query = database
        .select(selectShape)
        .from(workspaces)
        .where(and(...conditions))
        .$dynamic();
      if (limit !== undefined) query = query.limit(limit);
      if (offset !== undefined) query = query.offset(offset);
      return c.json(await query);
    }

    const conditions = [eq(issues.projectId, projectId!)];
    if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
    let query = database
      .select(selectShape)
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(and(...conditions))
      .$dynamic();
    if (limit !== undefined) query = query.limit(limit);
    if (offset !== undefined) query = query.offset(offset);
    return c.json(await query);
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
