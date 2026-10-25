import { z } from "zod";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { runLandLocalWorkerGate } from "../services/land-local-worker-gate.service.js";

const bodySchema = z.object({
  branch: z.string().min(1),
  sha: z.string().min(1),
  steps: z.array(z.object({ name: z.string().regex(/^[\w:.-]+$/), command: z.string().min(1) })).min(1),
  changedFiles: z.array(z.string()),
  workerName: z.string().min(1).optional(),
  retryScope: z.string().min(1).optional(),
});

/** `train land-local --on-worker` (#1612): place the gate of a locally assembled train on a verify worker. */
export function createProjectLandLocalRoute(database: Database) {
  const router = createRouter();

  // POST /api/projects/:id/land-local/worker-gate
  router.post("/:id/land-local/worker-gate", async (c) => {
    const body = await parseJsonBody(c, bodySchema);
    return c.json(await runLandLocalWorkerGate({ projectId: c.req.param("id"), ...body }, { database }));
  });

  return router;
}
