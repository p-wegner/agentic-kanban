import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { computeFocus } from "../services/focus.service.js";

// #606: the ranking moved to services/focus.service.ts; this route is the thin adapter.
export type { FocusIssue, FocusData } from "../services/focus.service.js";

export function createFocusRoute(database: Database) {
  const router = createRouter();

  // `now` is accepted for parity with the digest route and deterministic tests;
  // the focus ranking itself is point-in-time, not windowed.
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    const nowParam = c.req.query("now");
    return c.json(await computeFocus(projectId, database, nowParam ? new Date(nowParam) : new Date()));
  });

  return router;
}
