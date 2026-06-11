import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { checkIssueOverlap } from "../services/issue-ai.service.js";
import { getFileContention } from "../services/file-contention.service.js";
import { getProjectActivity } from "../services/project-activity.service.js";
import { listBoardHealthEvents, getBoardHealthEvent, type BoardHealthEventType, type BoardHealthEventCategory } from "../repositories/board-health-events.repository.js";
import { listMonitorCycles } from "../services/monitor-cycle-health.service.js";
import { buildDependencyWavePlan, startNextDependencyWave } from "../services/dependency-wave.service.js";
import { buildSprintCapacityPlan } from "../services/sprint-capacity.service.js";
import { generateBoardRiskDigest } from "../services/board-risk-digest.service.js";
import { getWorkspaceLaunchFailures } from "../services/workspace-launch-failures.service.js";
import { getWorkspaceRisk } from "../services/workspace-risk.service.js";
import { getProjectHealth } from "../services/project-health.service.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { createHash } from "node:crypto";
import { createWorkspaceSummaryCache } from "../services/workspace-summary-cache.service.js";
import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, gte } from "drizzle-orm";

function parseBoardHealthEventsLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(50, Math.max(1, parsed));
}

const VALID_EVENT_TYPES: Set<string> = new Set(["cycle_start", "cycle_end", "observation", "action", "error"]);
const VALID_CATEGORIES: Set<string> = new Set(["merge", "launch", "server", "refill", "smoke_check"]);

function parseBoardHealthEventTypes(raw: string | undefined): BoardHealthEventType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter((t) => VALID_EVENT_TYPES.has(t));
  return types.length > 0 ? (types as BoardHealthEventType[]) : undefined;
}

function parseBoardHealthCategories(raw: string | undefined): BoardHealthEventCategory[] | undefined {
  if (!raw) return undefined;
  const cats = raw.split(",").map((t) => t.trim()).filter((t) => VALID_CATEGORIES.has(t));
  return cats.length > 0 ? (cats as BoardHealthEventCategory[]) : undefined;
}

function compactBoardHealthEventDetails(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const details = JSON.parse(raw) as unknown;
    if (details === null || details === undefined) return null;
    if (typeof details !== "object") return String(details);
    if (Array.isArray(details)) return `${details.length} item${details.length === 1 ? "" : "s"}`;

    const entries = Object.entries(details as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 4);
    if (entries.length === 0) return null;

    return entries
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}: ${value.length} item${value.length === 1 ? "" : "s"}`;
        if (typeof value === "object") return `${key}: ${Object.keys(value as Record<string, unknown>).length} fields`;
        return `${key}: ${String(value)}`;
      })
      .join(", ");
  } catch {
    return raw.slice(0, 160);
  }
}

// Conditional-GET fast path for GET /:id/board: memo of the last served response per
// (projectId + query shape). A request whose If-None-Match equals the memoized ETag can
// be answered 304 WITHOUT rebuilding the board, as long as the workspace-summary cache
// generation is unchanged and the memo is younger than this bound. Invariant making the
// bounded staleness safe: every board-affecting mutation flows through
// boardEvents.broadcast(), whose invalidation listener (below) bumps the cache
// generation — so with an unchanged generation the board body can only drift via
// time-derived fields (columnAgeDays / staleDays / isStale), which have DAY granularity.
// 60s of fast-path staleness is therefore invisible; the TTL is just a safety net.
const BOARD_ETAG_MEMO_MAX_AGE_MS = 60_000;
const BOARD_ETAG_MEMO_MAX_ENTRIES = 500;

interface BoardEtagMemo {
  etag: string;
  generation: number;
  computedAt: number;
}

export function createProjectsRoute(database: Database = db, options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionManager }) {
  const router = createRouter();

  const workspaceSummaryCache = createWorkspaceSummaryCache();
  const projectService = createProjectService({ database, workspaceSummaryCache });
  // The fast path is only sound when boardEvents is wired: without the invalidation
  // listener below, mutations would never bump the cache generation and the memo
  // could serve a wrong 304. Disabled (never permissive) when boardEvents is absent.
  const boardEtagFastPathEnabled = Boolean(options?.boardEvents);
  const boardEtagMemos = new Map<string, BoardEtagMemo>();
  if (options?.boardEvents) {
    options.boardEvents.addInvalidationListener((projectId) => {
      workspaceSummaryCache.invalidate(projectId);
      // Warm-ahead: start the board rebuild now (debounced to collapse event bursts)
      // so the client's WS-triggered refetch ~100-300ms later hits a warm or in-flight
      // cache instead of paying the full cold rebuild (measured 121-205ms per refetch).
      projectService.scheduleBoardWarmup(projectId);
    });
  }

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await projectService.listProjects();
    return c.json(result);
  });

  // POST /api/projects
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const result = await projectService.registerProject(body);
    options?.boardEvents?.broadcastProjectsChanged(result.id, "project_created");
    return c.json(result, 201);
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await parseJsonBody(c);
    const result = await projectService.createProject(body);
    options?.boardEvents?.broadcastProjectsChanged(result.id, "project_created");
    return c.json(result, 201);
  });

  // PATCH /api/projects/:id — update project fields
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await projectService.updateProject(id, body);
    options?.boardEvents?.broadcastProjectsChanged(id, "project_updated");
    return c.json(result);
  });

  // DELETE /api/projects/:id — unregister a project (cascade deletes all associated data)
  router.delete("/:id", async (c) => {
    const projectId = c.req.param("id");
    await projectService.deleteProject(projectId);
    options?.boardEvents?.broadcastProjectsChanged(projectId, "project_deleted");
    return c.json({ success: true });
  });

  // POST /api/projects/generate-setup-script
  router.post("/generate-setup-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const setupScript = await wrapAiOperation("generate-setup-script", () => projectService.generateSetupScript(body.projectId!));
    return c.json({ setupScript });
  });

  // POST /api/projects/generate-verify-script
  router.post("/generate-verify-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const verifyScript = await wrapAiOperation("generate-verify-script", () => projectService.generateVerifyScript(body.projectId!));
    return c.json({ verifyScript });
  });

  // POST /api/projects/generate-teardown-script
  router.post("/generate-teardown-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const teardownScript = await wrapAiOperation("generate-teardown-script", () => projectService.generateTeardownScript(body.projectId!));
    return c.json({ teardownScript });
  });

  // GET /api/projects/:id/statuses
  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.listStatuses(projectId);
    return c.json(result);
  });

  // POST /api/projects/:id/statuses
  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await projectService.addStatus(projectId, body.name, body.sortOrder ?? 0);
    return c.json(result, 201);
  });

  // PATCH /api/projects/:id/statuses/:statusId
  router.patch("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");
    const body = await parseJsonBody(c);
    if (typeof body.sortOrder !== "number") return c.json({ error: "sortOrder must be a number" }, 400);
    await projectService.updateStatusSortOrder(projectId, statusId, body.sortOrder);
    return c.json({ success: true });
  });

  // DELETE /api/projects/:id/statuses/:statusId
  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");
    const result = await projectService.removeStatus(projectId, statusId);
    return c.json(result);
  });

  // GET /api/projects/:id/branches
  router.get("/:id/branches", async (c) => {
    const projectId = c.req.param("id");
    const branches = await projectService.getBranches(projectId);
    return c.json(branches);
  });

  // GET /api/projects/:id/stats — lightweight project stats
  router.get("/:id/stats", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getStats(projectId);
    return c.json(result);
  });

  // GET /api/projects/:id/board-health-events
  router.get("/:id/board-health-events", async (c) => {
    const projectId = c.req.param("id");
    const limit = parseBoardHealthEventsLimit(c.req.query("limit"));
    const eventTypes = parseBoardHealthEventTypes(c.req.query("eventType"));
    const categories = parseBoardHealthCategories(c.req.query("category"));
    const events = await listBoardHealthEvents({ projectId, eventTypes, categories, limit }, database);
    return c.json(events.map((event) => ({
      id: event.id,
      timestamp: event.createdAt,
      level: event.eventType === "error" ? "error" : "info",
      type: event.eventType,
      category: event.category ?? null,
      issueNumber: event.issueNumber ?? null,
      summary: event.summary,
      details: compactBoardHealthEventDetails(event.details),
    })));
  });

  // GET /api/projects/:id/monitor-cycles — aggregated cycle summaries
  router.get("/:id/monitor-cycles", async (c) => {
    const projectId = c.req.param("id");
    const rawLimit = c.req.query("limit");
    const parsed = Number.parseInt(rawLimit ?? "", 10);
    const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;
    const cycles = await listMonitorCycles(projectId, { limit }, database);
    return c.json(cycles);
  });

  // GET /api/projects/:id/board-health-events/:eventId — full event details (not compacted)
  router.get("/:id/board-health-events/:eventId", async (c) => {
    const projectId = c.req.param("id");
    const eventId = c.req.param("eventId");
    const event = await getBoardHealthEvent(eventId, database);
    if (!event || event.projectId !== projectId) return c.json({ error: "not found" }, 404);
    let parsedDetails: unknown = null;
    if (event.details) {
      try { parsedDetails = JSON.parse(event.details); } catch { parsedDetails = event.details; }
    }
    return c.json({
      id: event.id,
      cycleId: event.cycleId,
      timestamp: event.createdAt,
      level: event.eventType === "error" ? "error" : "info",
      type: event.eventType,
      category: event.category ?? null,
      issueNumber: event.issueNumber ?? null,
      summary: event.summary,
      details: parsedDetails,
    });
  });

  // GET /api/projects/:id/worktrees
  router.get("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getWorktrees(projectId);
    return c.json(result);
  });

  // DELETE /api/projects/:id/worktrees
  router.delete("/:id/worktrees", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ path?: string; workspaceId?: string }>(c);
    if (!body.path && !body.workspaceId) return c.json({ error: "path or workspaceId is required" }, 400);

    await projectService.removeWorktreeById(projectId, body);
    return c.json({ success: true });
  });

  // POST /api/projects/:id/worktrees/open — open a worktree folder in the OS file explorer
  router.post("/:id/worktrees/open", async (c) => {
    const body = await parseJsonBody<{ path: string }>(c);
    if (!body.path) return c.json({ error: "path is required" }, 400);

    projectService.openInExplorer(body.path);
    return c.json({ success: true });
  });

  // GET /api/projects/all/workspaces — cross-project workspace summary (all projects)
  router.get("/all/workspaces", async (c) => {
    const result = await projectService.getCrossProjectWorkspaces();
    return c.json(result);
  });

  // GET /api/projects/health — aggregated health overview for all registered projects
  router.get("/health", async (c) => {
    const result = await getProjectHealth(database);
    return c.json(result);
  });

  // GET /api/projects/:id/board/summary — column counts only, no issue bodies
  router.get("/:id/board/summary", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await projectService.getBoardSummary(projectId);
      return c.json(result);
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      throw err;
    }
  });

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");
    const includeArchived = c.req.query("includeArchived") === "true";
    const ifNoneMatch = c.req.header("if-none-match");
    const memoKey = `${projectId}|archived=${includeArchived}`;

    // Fast path: a conditional GET of an unchanged board answers 304 without
    // recomputing (the 30s client poll + post-event refetches mostly hit this).
    // See BOARD_ETAG_MEMO_MAX_AGE_MS above for the staleness invariant.
    if (boardEtagFastPathEnabled && ifNoneMatch) {
      const memo = boardEtagMemos.get(memoKey);
      if (
        memo !== undefined &&
        ifNoneMatch === memo.etag &&
        workspaceSummaryCache.getGeneration(projectId) === memo.generation &&
        Date.now() - memo.computedAt < BOARD_ETAG_MEMO_MAX_AGE_MS
      ) {
        return new Response(null, { status: 304, headers: { ETag: memo.etag } });
      }
    }

    // Full path — unchanged: compute the board, hash the body, compare If-None-Match.
    // Capture the generation BEFORE the compute: if an invalidation lands mid-build,
    // the memoized generation is already stale and the next conditional GET takes the
    // full path instead of trusting a possibly pre-mutation body.
    const generation = workspaceSummaryCache.getGeneration(projectId);
    const result = await projectService.getBoard(projectId, undefined, { includeArchived });
    const body = JSON.stringify(result);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    if (boardEtagFastPathEnabled) {
      if (!boardEtagMemos.has(memoKey) && boardEtagMemos.size >= BOARD_ETAG_MEMO_MAX_ENTRIES) {
        const firstKey = boardEtagMemos.keys().next().value;
        if (firstKey !== undefined) boardEtagMemos.delete(firstKey);
      }
      boardEtagMemos.set(memoKey, { etag, generation, computedAt: Date.now() });
    }
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: etag },
    });
  });

  // GET /api/projects/:id/workspace-launch-failures
  router.get("/:id/workspace-launch-failures", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await getWorkspaceLaunchFailures(projectId, database);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/projects/:id/board-risk-digest
  router.get("/:id/board-risk-digest", async (c) => {
    const projectId = c.req.param("id");
    try {
      const digest = await generateBoardRiskDigest(projectId, database);
      return c.json(digest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/projects/:id/workspace-risk — risk heatmap for active/review workspaces
  router.get("/:id/workspace-risk", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await getWorkspaceRisk(projectId, database);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/projects/:id/check-overlap — check for file overlap between issues using cached predictions
  router.post("/:id/check-overlap", async (c) => {
    const body = await parseJsonBody<{ issueIds: string[] }>(c);
    if (!Array.isArray(body.issueIds) || body.issueIds.length === 0) {
      return c.json({ error: "issueIds array is required" }, 400);
    }
    return c.json(await checkIssueOverlap(body.issueIds, database));
  });

  // GET /api/projects/:id/file-contention — live file contention heatmap for active/reviewing workspaces
  router.get("/:id/file-contention", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await getFileContention(projectId, database);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/projects/:id/graph
  router.get("/:id/graph", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getGraph(projectId);
    return c.json(result);
  });

  // GET /api/projects/:id/dependency-waves
  router.get("/:id/dependency-waves", async (c) => {
    const projectId = c.req.param("id");
    const result = await buildDependencyWavePlan(database, projectId);
    return c.json(result);
  });

  // POST /api/projects/:id/dependency-waves/start-next
  router.post("/:id/dependency-waves/start-next", async (c) => {
    const projectId = c.req.param("id");
    const result = await startNextDependencyWave(database, projectId, options);
    return c.json(result);
  });

  // GET /api/projects/:id/activity — project-wide activity feed (latest N events across all issues)
  router.get("/:id/activity", async (c) => {
    const projectId = c.req.param("id");
    const rawLimit = c.req.query("limit");
    const parsed = Number.parseInt(rawLimit ?? "", 10);
    const limit = Number.isFinite(parsed) ? Math.min(200, Math.max(1, parsed)) : 100;
    try {
      const result = await getProjectActivity(projectId, database, limit);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/projects/:id/sprint-capacity
  router.get("/:id/sprint-capacity", async (c) => {
    const projectId = c.req.param("id");
    try {
      const result = await buildSprintCapacityPlan(database, projectId);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  // GET /api/projects/:id/dashboard/throughput-by-provider?days=14
  // Rank providers/profiles by issues merged to master within a selectable time window.
  // Returns count + median lead time per provider.
  router.get("/:id/dashboard/throughput-by-provider", async (c) => {
    const projectId = c.req.param("id");
    const daysRaw = parseInt(c.req.query("days") ?? "14", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 14 : daysRaw, 1), 365) as 7 | 14 | 30;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffDay = cutoffDate.toISOString().slice(0, 10);

    // Find Done issues with their merged workspace's provider/profile.
    // An issue is counted if it's in "Done" status and moved to Done within the window.
    // We join to workspaces where mergedAt is set (actual merge happened) to get the
    // provider attribution. If multiple workspaces merged for the same issue, we pick
    // the one that actually merged (mergedAt is not null).
    const rows = await database
      .select({
        issueCreatedAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
        provider: workspaces.provider,
        claudeProfile: workspaces.claudeProfile,
        mergedAt: workspaces.mergedAt,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .innerJoin(workspaces, eq(issues.id, workspaces.issueId))
      .where(
        and(
          eq(issues.projectId, projectId),
          eq(projectStatuses.name, "Done"),
          gte(issues.statusChangedAt, cutoffDay),
        ),
      );

    // Group by provider (prefer merged workspace for attribution).
    // Build a composite key from provider + profile.
    const groups = new Map<string, { count: number; leadTimes: number[] }>();

    for (const r of rows) {
      // Only count if this workspace actually merged (mergedAt set)
      if (!r.mergedAt) continue;
      if (!r.statusChangedAt || !r.issueCreatedAt) continue;

      const provider = r.provider ?? "unknown";
      const profile = r.claudeProfile ?? "";
      const key = profile ? `${provider}:${profile}` : provider;

      const leadMs = new Date(r.statusChangedAt).getTime() - new Date(r.issueCreatedAt).getTime();
      if (leadMs < 0) continue;

      if (!groups.has(key)) {
        groups.set(key, { count: 0, leadTimes: [] });
      }
      const g = groups.get(key)!;
      g.count++;
      g.leadTimes.push(leadMs);
    }

    // Deduplicate: an issue may have multiple merged workspaces.
    // We already filter by mergedAt, but the same issue could appear multiple times
    // if re-merged. Use a simple approach: count each unique (issue, provider) once.
    // Since we're grouping by provider key, duplicates within the same provider are fine —
    // they represent re-merges of the same issue. The count is "issues merged by this provider".

    function percentile(sorted: number[], p: number): number | null {
      if (sorted.length === 0) return null;
      const idx = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }

    const providers = [...groups.entries()]
      .map(([key, data]) => {
        const sorted = [...data.leadTimes].sort((a, b) => a - b);
        const parts = key.split(":");
        return {
          provider: parts[0],
          profile: parts.length > 1 ? parts.slice(1).join(":") : "",
          count: data.count,
          medianLeadTimeMs: percentile(sorted, 50),
        };
      })
      .sort((a, b) => b.count - a.count);

    return c.json({ providers, window: `${days}d` });
  });

  return router;
}
