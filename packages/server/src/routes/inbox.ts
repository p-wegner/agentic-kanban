import { createRouter } from "../middleware/create-router.js";
import type { Database } from "../db/index.js";
import { listInbox } from "../services/inbox.service.js";

/** Cross-project "Waiting on you" inbox (#302): GET /api/inbox. */
export function createInboxRoute(database: Database) {
  const app = createRouter();
  app.get("/", async (c) => c.json(await listInbox(database)));
  return app;
}
