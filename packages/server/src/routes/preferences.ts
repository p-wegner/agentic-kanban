import { Hono } from "hono";
import type { Database } from "../db/index.js";
import { createPreferenceService } from "../services/preference.service.js";

export function createPreferencesRoute(database: Database) {
  const router = new Hono();
  const preferenceService = createPreferenceService({ database });

  // GET /api/preferences/active-project
  router.get("/active-project", async (c) => {
    const projectId = await preferenceService.getActiveProjectId();
    return c.json({ projectId });
  });

  // PUT /api/preferences/active-project
  router.put("/active-project", async (c) => {
    const body = await c.req.json();
    await preferenceService.setActiveProjectId(body.projectId ?? "");
    return c.json({ projectId: body.projectId });
  });

  // GET /api/preferences/settings — get all agent settings
  router.get("/settings", async (c) => {
    return c.json(await preferenceService.getSettings());
  });

  // PUT /api/preferences/settings — update agent settings
  router.put("/settings", async (c) => {
    const body = await c.req.json() as Record<string, string>;
    await preferenceService.updateSettings(body);
    return c.json({ ok: true });
  });

  // GET /api/preferences/claude-profiles — list available claude profiles
  router.get("/claude-profiles", (c) => {
    return c.json({ profiles: preferenceService.listClaudeProfiles() });
  });

  // GET /api/preferences/codex-profiles — list available codex profiles
  router.get("/codex-profiles", (c) => {
    return c.json({ profiles: preferenceService.listCodexProfiles() });
  });

  // GET /api/preferences/copilot-profiles
  router.get("/copilot-profiles", (_c) => {
    return _c.json({ profiles: [] });
  });

  return router;
}
