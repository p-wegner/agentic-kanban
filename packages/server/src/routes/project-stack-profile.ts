import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getStackProfile, populateStackProfile, saveManualStackProfile } from "../services/stack-profile.service.js";
import type { StackProfile } from "@agentic-kanban/shared";

/**
 * Project stack-profile feature endpoints (#786). Extracted from the 400-commit
 * routes/projects.ts grab-bag (arch-review §1.5). Mounted at the SAME `/projects`
 * prefix, so paths/behavior are unchanged — a move, not an API change.
 */
export function createProjectStackProfileRoute(database: Database) {
  const router = createRouter();

  // GET /api/projects/:id/stack-profile — the durable per-project stack descriptor (#786).
  // Returns the persisted profile; computes+persists one on demand if absent (?refresh=true
  // forces a recompute). The feedback harness reads this ONE descriptor.
  router.get("/:id/stack-profile", async (c) => {
    const projectId = c.req.param("id");
    const refresh = c.req.query("refresh") === "true";

    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "Project not found" }, 404);

    let profile = refresh ? null : await getStackProfile(projectId, database);
    if (!profile) {
      profile = await populateStackProfile(projectId, project.repoPath, database);
    }
    return c.json({ projectId, profile });
  });

  // PUT /api/projects/:id/stack-profile — override the stack profile from the UI.
  // Marks the saved profile source="manual" so a later auto-detect won't silently clobber it.
  router.put("/:id/stack-profile", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const body = await parseJsonBody<Partial<StackProfile>>(c);
    const merged = await saveManualStackProfile(projectId, body, database, project.repoPath);
    return c.json({ projectId, profile: merged });
  });

  return router;
}
