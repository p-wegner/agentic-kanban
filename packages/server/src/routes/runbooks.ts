import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listRunbooks, readRunbook } from "../services/runbooks.service.js";
export type { RunbookEntry } from "../services/runbooks.service.js";

/**
 * Runbooks route — surfaces project operational docs without leaving the app.
 * Mounted under /projects.
 *
 * GET /api/projects/:id/runbooks          — list available runbook/doc files
 * GET /api/projects/:id/runbooks/content  — serve file content by ?path= query param
 */
export function createRunbooksRoute(database: Database) {
  const router = createRouter();

  // GET /api/projects/:id/runbooks — list available docs
  router.get("/:id/runbooks", async (c) => {
    const project = await getProjectById(c.req.param("id"), database);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(await listRunbooks(project.repoPath));
  });

  // GET /api/projects/:id/runbooks/content?path=<relative-path> — read file content
  router.get("/:id/runbooks/content", async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path query param is required" }, 400);
    const project = await getProjectById(c.req.param("id"), database);
    if (!project) return c.json({ error: "project not found" }, 404);

    // The traversal guard lives in readRunbook now; the route keeps the status mapping
    // it always had (400 invalid path / 404 missing file).
    const result = await readRunbook(project.repoPath, relPath);
    if (!result.ok) {
      return result.reason === "invalid-path"
        ? c.json({ error: "invalid path" }, 400)
        : c.json({ error: "file not found" }, 404);
    }
    return c.json(result.runbook);
  });

  return router;
}
