import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createPreferenceService } from "../services/preference.service.js";
import {
  listAgentProfileHealth,
  preflightAgentProfile,
  type AgentProfilePreflightResult,
} from "../services/agent-profile-health.service.js";
import { getMcpHealthSummary, probeMcpHealth } from "../services/mcp-health.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { preferences } from "@agentic-kanban/shared/schema";
import type { ProviderName } from "../services/agent-provider.js";

export function createPreferencesRoute(database: Database = db) {
  const router = createRouter();
  const preferenceService = createPreferenceService({ database });

  // GET /api/preferences/active-project
  router.get("/active-project", async (c) => {
    const projectId = await preferenceService.getActiveProjectId();
    return c.json({ projectId, value: projectId });
  });

  // PUT /api/preferences/active-project
  router.put("/active-project", async (c) => {
    const body = await parseJsonBody<{ projectId?: string }>(c);
    await preferenceService.setActiveProjectId(body.projectId ?? "");
    return c.json({ projectId: body.projectId, value: body.projectId });
  });

  // GET /api/preferences/settings — get all agent settings
  router.get("/settings", async (c) => {
    return c.json(await preferenceService.getSettings());
  });

  // PUT /api/preferences/settings — update agent settings
  router.put("/settings", async (c) => {
    const body = await parseJsonBody<Record<string, string>>(c);
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
    return _c.json({ profiles: preferenceService.listCopilotProfiles() });
  });

  router.get("/agent-profiles/health", async (c) => {
    return c.json({
      profiles: await listAgentProfileHealth(database, {
        claudeProfiles: preferenceService.listClaudeProfiles(),
        codexProfiles: preferenceService.listCodexProfiles(),
        copilotProfiles: preferenceService.listCopilotProfiles(),
      }),
    });
  });

  router.post("/agent-profiles/preflight", async (c) => {
    const body = await parseJsonBody<{ provider?: string; profileName?: string }>(c);
    const provider = parseProvider(body.provider);
    if (!provider) {
      return c.json({ ok: false, status: "error", errors: ["Unsupported provider"], warnings: [], flags: [], command: "", provider: body.provider ?? "", profileName: body.profileName ?? "" }, 400);
    }
    const profileName = body.profileName?.trim() || "default";
    const prefRows = await database.select().from(preferences);
    const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
    const result: AgentProfilePreflightResult = preflightAgentProfile(prefMap, provider, profileName);
    return c.json(result);
  });

  router.get("/mcp/health", (c) => {
    return c.json(getMcpHealthSummary());
  });

  router.post("/mcp/probe", async (c) => {
    return c.json(await probeMcpHealth());
  });

  return router;
}

function parseProvider(provider: string | undefined): ProviderName | null {
  if (provider === "claude" || provider === "codex" || provider === "copilot") return provider;
  return null;
}
