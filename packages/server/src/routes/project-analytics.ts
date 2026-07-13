import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { computeThroughputByProvider } from "../services/dashboard-analytics.service.js";
import { clampDays, cutoffDayFor } from "../lib/analytics-window.js";
import { getDoneIssueProviderAttribution } from "../repositories/project.repository.js";
import { checkIssueOverlap } from "../services/issue-ai.service.js";
import { getFileContention } from "../services/file-contention.service.js";
import { listMonitorCycles } from "../services/monitor-cycle-health.service.js";
import { buildDependencyWavePlan, startNextDependencyWave } from "../services/dependency-wave.service.js";
import { buildSprintCapacityPlan } from "../services/sprint-capacity.service.js";
import { generateBoardRiskDigest } from "../services/board-risk-digest.service.js";
import { getWorkspaceLaunchFailures } from "../services/workspace-launch-failures.service.js";
import { getWorkspaceRisk } from "../services/workspace-risk.service.js";

/**
 * Project analytics / planning feature endpoints — the non-CRUD "everything is
 * project-scoped" grab-bag that used to accrete on the 400-commit routes/projects.ts
 * hub (arch-review §1.5, conflict-tax reduction). Mounted at the SAME `/projects`
 * prefix as routes/projects.ts, so every path/behavior is byte-for-byte unchanged —
 * this is a move, not an API change. New analytics endpoints append HERE.
 */
export function createProjectAnalyticsRoute(
  database: Database,
  options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionManager },
) {
  const router = createRouter();

  // GET /api/projects/:id/monitor-cycles — aggregated cycle summaries
  router.get("/:id/monitor-cycles", async (c) => {
    const projectId = c.req.param("id");
    const rawLimit = c.req.query("limit");
    const parsed = Number.parseInt(rawLimit ?? "", 10);
    const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 20;
    const cycles = await listMonitorCycles(projectId, { limit }, database);
    return c.json(cycles);
  });

  // GET /api/projects/:id/workspace-launch-failures
  router.get("/:id/workspace-launch-failures", async (c) => {
    const projectId = c.req.param("id");
    const result = await getWorkspaceLaunchFailures(projectId, database);
    return c.json(result);
  });

  // GET /api/projects/:id/board-risk-digest
  router.get("/:id/board-risk-digest", async (c) => {
    const projectId = c.req.param("id");
    const digest = await generateBoardRiskDigest(projectId, database);
    return c.json(digest);
  });

  // GET /api/projects/:id/workspace-risk — risk heatmap for active/review workspaces
  router.get("/:id/workspace-risk", async (c) => {
    const projectId = c.req.param("id");
    const result = await getWorkspaceRisk(projectId, database);
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
    const result = await getFileContention(projectId, database);
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

  // GET /api/projects/:id/sprint-capacity
  router.get("/:id/sprint-capacity", async (c) => {
    const projectId = c.req.param("id");
    const result = await buildSprintCapacityPlan(database, projectId);
    return c.json(result);
  });

  // GET /api/projects/:id/dashboard/throughput-by-provider?days=14
  // Rank providers/profiles by issues merged to master within a selectable time window.
  // Returns count + median lead time per provider.
  router.get("/:id/dashboard/throughput-by-provider", async (c) => {
    const projectId = c.req.param("id");
    const days = clampDays(c.req.query("days"), 14);

    // Find Done issues with their merged workspace's provider/profile.
    // An issue is counted if it's in "Done" status and moved to Done within the window.
    // We join to workspaces where mergedAt is set (actual merge happened) to get the
    // provider attribution. If multiple workspaces merged for the same issue, the first
    // merged workspace wins (deduplicated by issue ID).
    const rows = await getDoneIssueProviderAttribution(projectId, cutoffDayFor(new Date(), days), database);
    return c.json(computeThroughputByProvider(rows, days));
  });

  return router;
}
