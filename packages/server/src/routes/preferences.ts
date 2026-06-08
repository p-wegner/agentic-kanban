import { homedir } from "node:os";
import { sep } from "node:path";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createPreferenceService } from "../services/preference.service.js";
import { spawnCodexLogin } from "../services/codex-login.service.js";
import { listCodexLicenses, parseCodexLicenseRing } from "../services/codex-license-ring.js";
import { spawnClaudeLogin } from "../services/claude-login.service.js";
import { listClaudeSubscriptions, parseClaudeSubscriptionRing } from "../services/claude-subscription-ring.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { PREF_CODEX_LICENSE_RING, PREF_CLAUDE_SUBSCRIPTION_RING } from "../constants/preference-keys.js";
import {
  listAgentProfileHealth,
  preflightAgentProfile,
  type AgentProfilePreflightResult,
} from "../services/agent-profile-health.service.js";
import { getMcpHealthSummary, probeMcpHealth } from "../services/mcp-health.service.js";
import { fetchLiveQuotaUsage } from "../services/quota-usage.service.js";
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
  router.get("/claude-profiles", async (c) => {
    return c.json({ profiles: await preferenceService.listClaudeProfiles() });
  });

  // GET /api/preferences/codex-profiles — list available codex profiles
  router.get("/codex-profiles", async (c) => {
    return c.json({ profiles: await preferenceService.listCodexProfiles() });
  });

  // GET /api/preferences/copilot-profiles
  router.get("/copilot-profiles", (_c) => {
    return _c.json({ profiles: preferenceService.listCopilotProfiles() });
  });

  // GET /api/preferences/home-dir — so the client can infer a Codex license's
  // default CODEX_HOME (`<home>/.codex-<profile>`) without re-implementing path joins.
  router.get("/home-dir", (c) => {
    return c.json({ homeDir: homedir(), sep: sep });
  });

  // GET /api/preferences/codex-licenses — unified view of selectable Codex licenses
  // (auto-discovered ~/.codex-<name> dirs merged with the rotation ring) + login status.
  router.get("/codex-licenses", async (c) => {
    const ringRaw = await getPreference(PREF_CODEX_LICENSE_RING, database);
    return c.json({ licenses: listCodexLicenses(parseCodexLicenseRing(ringRaw)) });
  });

  // POST /api/preferences/codex-login — open a real terminal running `codex login`
  // for a license dir. The OAuth callback needs a foreground window, so this is the
  // only way to do it from the UI; returns the equivalent manual command too.
  router.post("/codex-login", async (c) => {
    const body = await parseJsonBody<{ codexHome?: string }>(c);
    const codexHome = body.codexHome?.trim();
    if (!codexHome) {
      return c.json({ ok: false, error: "codexHome is required" }, 400);
    }
    try {
      const { command } = spawnCodexLogin(codexHome);
      return c.json({ ok: true, codexHome, command });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /api/preferences/claude-subscriptions — unified view of selectable Claude
  // subscriptions (auto-discovered ~/.claude-<name> dirs merged with the rotation
  // ring) + login status. Mirrors /codex-licenses.
  router.get("/claude-subscriptions", async (c) => {
    const ringRaw = await getPreference(PREF_CLAUDE_SUBSCRIPTION_RING, database);
    return c.json({ subscriptions: listClaudeSubscriptions(parseClaudeSubscriptionRing(ringRaw)) });
  });

  // POST /api/preferences/claude-login — open a real terminal running `claude /login`
  // for a subscription dir. The OAuth flow needs a foreground window, so this is the
  // only way to do it from the UI; returns the equivalent manual command too.
  router.post("/claude-login", async (c) => {
    const body = await parseJsonBody<{ configDir?: string }>(c);
    const configDir = body.configDir?.trim();
    if (!configDir) {
      return c.json({ ok: false, error: "configDir is required" }, 400);
    }
    try {
      const { command } = spawnClaudeLogin(configDir);
      return c.json({ ok: true, configDir, command });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  router.get("/agent-profiles/health", async (c) => {
    return c.json({
      profiles: await listAgentProfileHealth(database, {
        claudeProfiles: await preferenceService.listClaudeProfiles(),
        codexProfiles: await preferenceService.listCodexProfiles(),
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

  // GET /api/preferences/quota-usage — live quota from tampermonkey-direct
  router.get("/quota-usage", async (c) => {
    try {
      const data = await fetchLiveQuotaUsage();
      return c.json(data);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err), providers: [], scrapedAt: new Date().toISOString() },
        503,
      );
    }
  });

  return router;
}

function parseProvider(provider: string | undefined): ProviderName | null {
  if (provider === "claude" || provider === "codex" || provider === "copilot") return provider;
  return null;
}
