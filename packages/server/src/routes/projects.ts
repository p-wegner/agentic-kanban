import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createProjectService } from "../services/project.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { checkIssueOverlap } from "../services/issue-ai.service.js";
import { getFileContention } from "../services/file-contention.service.js";
import { listBoardHealthEvents, type BoardHealthEventType, type BoardHealthEventCategory } from "../repositories/board-health-events.repository.js";
import { buildDependencyWavePlan, startNextDependencyWave } from "../services/dependency-wave.service.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

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

export function createProjectsRoute(database: Database = db, options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionManager }) {
  const router = createRouter();

  const projectService = createProjectService({ database });

  // GET /api/projects
  router.get("/", async (c) => {
    const result = await projectService.listProjects();
    return c.json(result);
  });

  // POST /api/projects
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const result = await projectService.registerProject(body);
    return c.json(result, 201);
  });

  // POST /api/projects/create — create a new directory as a git repo and register it
  router.post("/create", async (c) => {
    const body = await parseJsonBody(c);
    const result = await projectService.createProject(body);
    return c.json(result, 201);
  });

  // PATCH /api/projects/:id — update project fields
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await projectService.updateProject(id, body);
    return c.json(result);
  });

  // DELETE /api/projects/:id — unregister a project (cascade deletes all associated data)
  router.delete("/:id", async (c) => {
    const projectId = c.req.param("id");
    await projectService.deleteProject(projectId);
    return c.json({ success: true });
  });

  // POST /api/projects/generate-setup-script
  router.post("/generate-setup-script", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const setupScript = await wrapAiOperation("generate-setup-script", () => projectService.generateSetupScript(body.projectId!));
    return c.json({ setupScript });
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

  // GET /api/projects/:id/board
  router.get("/:id/board", async (c) => {
    const projectId = c.req.param("id");
    const result = await projectService.getBoard(projectId);
    return c.json(result);
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

  return router;
}
