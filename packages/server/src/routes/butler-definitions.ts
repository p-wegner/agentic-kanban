import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import {
  listButlerDefinitions,
  createButlerDefinition,
  updateButlerDefinition,
  deleteButlerDefinition,
  MAX_BUTLERS,
} from "../services/butler-definitions.service.js";

/**
 * Butler definitions CRUD — the GLOBAL set of named butlers (e.g. "Smart"/opus,
 * "Quick"/haiku), shared across all projects. Mounted at /api/butler-definitions.
 * Per-project warm-session state lives under /api/projects/:id/butlers (butler.ts).
 */
export function createButlerDefinitionsRoute(database: Database) {
  const router = createRouter();

  // GET /api/butler-definitions — list defined butlers (always includes "default").
  router.get("/", async (c) => {
    const butlers = await listButlerDefinitions(database);
    return c.json({ butlers, max: MAX_BUTLERS });
  });

  // POST /api/butler-definitions — create a named butler { name, model?, provider? }.
  router.post("/", async (c) => {
    const body = await parseJsonBody<{ name?: string; model?: string; provider?: string }>(c);
    const provider = body.provider === "codex" ? "codex" : body.provider === "claude" ? "claude" : undefined;
    try {
      const butler = await createButlerDefinition(database, { name: body.name ?? "", model: body.model, provider });
      return c.json({ butler }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to create butler" }, 400);
    }
  });

  // PUT /api/butler-definitions/:bid — update name, model, and/or provider.
  router.put("/:bid", async (c) => {
    const body = await parseJsonBody<{ name?: string; model?: string; provider?: string | null }>(c);
    const provider = body.provider === "codex" ? "codex" : body.provider === "claude" ? "claude" : body.provider === null ? null : undefined;
    try {
      const butler = await updateButlerDefinition(database, c.req.param("bid"), { name: body.name, model: body.model, provider });
      return c.json({ butler });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to update butler" }, 400);
    }
  });

  // DELETE /api/butler-definitions/:bid — remove a named butler ("default" is protected).
  router.delete("/:bid", async (c) => {
    try {
      await deleteButlerDefinition(database, c.req.param("bid"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to delete butler" }, 400);
    }
  });

  return router;
}
