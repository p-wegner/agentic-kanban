import { createRouter } from "../middleware/create-router.js";
import { createIssueService } from "../services/issue.service.js";
import type { Database } from "../db/index.js";

const DEFAULT_DAYS = 14;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

export function createStaleIssuesRoute(database: Database) {
  const router = createRouter();
  const issueService = createIssueService({ database });

  router.get("/:projectId/issues/stale", async (c) => {
    const { projectId } = c.req.param();

    const daysParam = c.req.query("days");
    const days = daysParam ? Number(daysParam) : DEFAULT_DAYS;
    const clampedDays = Math.min(Math.max(days, MIN_DAYS), MAX_DAYS);

    const includeDone = c.req.query("includeDone") === "true";

    const issues = await issueService.listIssues(projectId);

    const filtered = issues.filter((i) => includeDone || i.statusName !== "cancelled");

    const now = Date.now();
    const withAge = filtered.map((issue) => ({
      ...issue,
      daysSinceUpdate: Math.floor((now - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
    }));

    const stale = withAge.filter((issue) => issue.daysSinceUpdate < clampedDays);

    const sorted = [...stale].sort((a, b) => a.daysSinceUpdate - b.daysSinceUpdate);

    return c.json(sorted);
  });

  return router;
}
