import { createRouter } from "../middleware/create-router.js";
import { getSlowRequests } from "../middleware/slow-request-logger.js";

export function createMetricsRoute() {
  const router = createRouter();

  router.get("/slow-requests", (c) => {
    return c.json({ entries: getSlowRequests() });
  });

  return router;
}
