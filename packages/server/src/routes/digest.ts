import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { computeDigest, parseRange } from "../services/digest.service.js";

// #606: the aggregation moved to services/digest.service.ts; this route is the thin adapter.
export type { DigestRange, DigestIssueRef, SessionDigestEntry, DigestData } from "../services/digest.service.js";

export function createDigestRoute(database: Database) {
  const router = createRouter();

  // `now` is injectable for deterministic time-window tests (nowOverride pattern).
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    const range = parseRange(c.req.query("range"));
    const nowParam = c.req.query("now");
    return c.json(await computeDigest(projectId, range, database, nowParam ? new Date(nowParam) : new Date()));
  });

  return router;
}
