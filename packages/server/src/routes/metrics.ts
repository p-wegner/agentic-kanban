import { createRouter } from "../middleware/create-router.js";
import { getSlowRequests } from "../middleware/slow-request-logger.js";
import { getLoopLagMonitor, LOOP_LAG_WARN_MS } from "../lib/loop-lag-registry.js";

export function createMetricsRoute() {
  const router = createRouter();

  router.get("/slow-requests", (c) => {
    // Loop lag rides along here on purpose (#347): a slow-request entry alone cannot
    // distinguish "this handler was slow" from "this handler sat behind someone else's
    // block", and the two are only separable when read together. `?reset=1` closes the
    // window so a scraper gets disjoint samples; a plain read is non-destructive so
    // eyeballing the endpoint does not perturb the warning timer's window.
    const monitor = getLoopLagMonitor();
    const loopLag = monitor
      ? (c.req.query("reset") === "1" ? monitor.statsAndReset() : monitor.stats())
      : null;
    return c.json({ entries: getSlowRequests(), loopLag, loopLagWarnThresholdMs: LOOP_LAG_WARN_MS });
  });

  router.get("/loop-lag", (c) => {
    const monitor = getLoopLagMonitor();
    if (!monitor) return c.json({ error: "loop_lag_monitor_not_started" }, 503);
    const stats = c.req.query("reset") === "1" ? monitor.statsAndReset() : monitor.stats();
    return c.json({ loopLag: stats, warnThresholdMs: LOOP_LAG_WARN_MS });
  });

  return router;
}
