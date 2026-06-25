import { homedir } from "node:os";
import { sep } from "node:path";
import type { Database } from "../db/index.js";
import { createPreferenceService } from "../services/preference.service.js";
import { spawnCodexLogin } from "../services/codex-login.service.js";
import { listCodexLicenses, parseCodexLicenseRing } from "../services/codex-license-ring.js";
import { spawnClaudeLogin } from "../services/claude-login.service.js";
import { listClaudeSubscriptions, parseClaudeSubscriptionRing } from "../services/claude-subscription-ring.js";
import { getPreference, getAllPreferences } from "../repositories/preferences.repository.js";
import { PREF_CODEX_LICENSE_RING, PREF_CLAUDE_SUBSCRIPTION_RING } from "../constants/preference-keys.js";
import {
  listAgentProfileHealth,
  preflightAgentProfile,
  type AgentProfilePreflightResult,
} from "../services/agent-profile-health.service.js";
import { getMcpHealthSummary, probeMcpHealth } from "../services/mcp-health.service.js";
import { fetchLiveQuotaUsage } from "../services/quota-usage.service.js";
import { createAgentSkillService } from "../services/agent-skill.service.js";
import { createTagService } from "../services/tag.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import type { ProviderName } from "../services/agent-provider.js";

export function createPreferencesRoute(database: Database) {
  const router = createRouter();
  const preferenceService = createPreferenceService({ database });
  const agentSkillService = createAgentSkillService({ database });
  const tagService = createTagService({ database });

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

  // GET /api/preferences/settings-bootstrap — one round trip for everything the Settings
  // panel needs for its first paint: agent settings + all profile lists + skills + tags.
  // Collapses 6 parallel requests into 1 so the panel's first render isn't throttled by
  // the browser's ~6-connection per-host HTTP/1.1 cap (which was queuing the requests to
  // ~1.2s). The heavy/secondary probes — agent-profile health (~600ms), mcp health,
  // install-status, branches — stay separate and are loaded deferred by the client.
  router.get("/settings-bootstrap", async (c) => {
    const [settings, claudeProfiles, codexProfiles, piProfiles, skills, tags] = await Promise.all([
      preferenceService.getSettings(),
      preferenceService.listClaudeProfiles(),
      preferenceService.listCodexProfiles(),
      preferenceService.listPiProfiles(),
      agentSkillService.listSkills(undefined, false),
      tagService.listTags(),
    ]);
    return c.json({
      settings,
      claudeProfiles,
      codexProfiles,
      copilotProfiles: preferenceService.listCopilotProfiles(),
      piProfiles,
      skills,
      tags,
    });
  });

  // PUT /api/preferences/settings — update agent settings.
  // Valid keys are persisted regardless, but any key not on the SETTINGS_KEYS
  // whitelist (nor a recognized dynamic key) is rejected with a 422 listing the
  // dropped keys — so a mistyped / un-registered setting fails loudly instead of
  // silently no-op'ing the way auto_rebase_on_continue and skip_preflight once did
  // (#874).
  router.put("/settings", async (c) => {
    const body = await parseJsonBody<Record<string, string>>(c);
    const { applied, dropped, divergence } = await preferenceService.updateSettings(body);
    // Write-time provider/Bullseye divergence guard (#903): reject BEFORE persisting
    // so the global provider/profile prefs can never drift from the active project's
    // Strategy Bullseye. Nothing was written when `divergence` is present.
    if (divergence) {
      return c.json(
        {
          ok: false,
          applied: [],
          divergence,
          error:
            `Refusing settings write: provider/profile would diverge from the project's Strategy Bullseye ` +
            `(${divergence.bullseyeProvider ?? "?"}:${divergence.bullseyeProfile ?? ""}). ` +
            `Change the default via the Strategy Bullseye instead, or align the Bullseye first.`,
        },
        422,
      );
    }
    if (dropped.length > 0) {
      return c.json(
        {
          ok: false,
          applied,
          droppedKeys: dropped,
          error: `Unknown setting key(s) rejected (not on the SETTINGS_KEYS whitelist): ${dropped.join(", ")}`,
        },
        422,
      );
    }
    return c.json({ ok: true, applied });
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

  // GET /api/preferences/pi-profiles
  router.get("/pi-profiles", async (c) => {
    return c.json({ profiles: await preferenceService.listPiProfiles() });
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
        piProfiles: await preferenceService.listPiProfiles(),
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
    const prefRows = await getAllPreferences(database);
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

  // GET /api/preferences/provider-divergence?projectId=<id>
  // Returns whether the global provider/profile prefs diverge from the project's
  // Strategy Bullseye. The Bullseye is the single source of truth for workspace
  // creation and the butler; divergence means the Settings UI shows a stale value.
  router.get("/provider-divergence", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) {
      return c.json({ hasBullseye: false, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false });
    }
    return c.json(await preferenceService.getProviderDivergence(projectId));
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
  if (provider === "claude" || provider === "codex" || provider === "copilot" || provider === "pi") return provider;
  return null;
}
