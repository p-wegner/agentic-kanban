import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { listRedDebt } from "../repositories/red-debt.repository.js";

/** GET /api/red-debt?projectId=&includeResolved= — the ledger for #915. */
export function createRedDebtRoute(database: Database) {
  const router = createRouter();

  // GET / — list a project's red-debt ledger entries (open-only by default).
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    const includeResolved = c.req.query("includeResolved") === "true";
    const entries = await listRedDebt(projectId, { includeResolved }, database);
    return c.json({ entries });
  });

  return router;
}
