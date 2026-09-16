import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "../lib/api.js";
import { getAgentProfilesHealth, getMcpHealth as fetchMcpHealth, getProviderDivergence, getSettingsBootstrap } from "../lib/settingsStore.js";
import { CODEX_DEFAULT_PROFILE, COPILOT_DEFAULT_PROFILE, DEFAULT_SETTINGS, PI_DEFAULT_PROFILE, uniqueProfiles, type AgentProfileHealth, type McpHealth, type Settings } from "../lib/settings-shared.js";
import { hydrateProjectSettings, type HerdrBootstrap, type ProjectSettingsState, type SettingsProjectRow } from "../lib/settingsPanelState.js";
import type { ProviderDivergence } from "./useProjectProviderControls.js";
import { useHerdrOptions } from "./useHerdrOptions.js";

type SkillRow = { id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean };
type TagRow = { id: string; name: string; color: string | null; isBuiltin: boolean };

/**
 * Owns the Settings panel's whole first-paint data load (#782, extended #1144): the single
 * `settings-bootstrap` round trip plus the heavier probes that stream in deferred after it,
 * so `SettingsPanel.tsx` itself only needs the state it renders, not the fetch ladder that
 * fills it.
 */
export function useSettingsBootstrap(params: {
  activeProjectId?: string | null;
  setSettings: Dispatch<SetStateAction<Settings>>;
  setProfiles: (v: string[]) => void;
  setCodexProfiles: (v: string[]) => void;
  setCopilotProfiles: (v: string[]) => void;
  setPiProfiles: (v: string[]) => void;
  setSkills: (v: SkillRow[]) => void;
  setTagsList: (v: TagRow[]) => void;
  setProviderDivergence: (v: ProviderDivergence) => void;
  setProjectSettings: (v: ProjectSettingsState) => void;
  setProfileHealth: (v: AgentProfileHealth[]) => void;
  setMcpHealth: (v: McpHealth) => void;
  setInstalledSkills: (v: Record<string, boolean>) => void;
  setProjectBranches: (v: { local: string[]; remote: string[] } | null) => void;
  setLoading: (v: boolean) => void;
}) {
  const { activeProjectId, setSettings, setProfiles, setCodexProfiles, setCopilotProfiles, setPiProfiles, setSkills, setTagsList, setProviderDivergence, setProjectSettings, setProfileHealth, setMcpHealth, setInstalledSkills, setProjectBranches, setLoading } = params;
  const { herdr, applyHerdrBootstrap } = useHerdrOptions();

  useEffect(() => {
    let cancelled = false;

    // --- Critical path: a single bootstrap round trip with everything needed for first
    // paint (settings + profile lists + skills + tags). One request instead of six, so it
    // grabs a connection immediately instead of queuing behind the browser's ~6-connection
    // per-host cap. The heavy status probes (agent-profile health ~600ms, branches ~200ms)
    // and the install-status batch are loaded deferred, after first paint. ---
    async function loadCore() {
      try {
        const boot = await getSettingsBootstrap<{
          settings: Record<string, string>;
          claudeProfiles: string[];
          codexProfiles: string[];
          copilotProfiles: string[];
          piProfiles: string[];
          skills: SkillRow[];
          tags: TagRow[];
        } & HerdrBootstrap>();
        if (cancelled) return;
        const data = boot.settings;
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setProfiles(boot.claudeProfiles);
        setCodexProfiles(uniqueProfiles(boot.codexProfiles, CODEX_DEFAULT_PROFILE));
        setCopilotProfiles(uniqueProfiles(boot.copilotProfiles?.length ? boot.copilotProfiles : [COPILOT_DEFAULT_PROFILE], COPILOT_DEFAULT_PROFILE));
        setPiProfiles(uniqueProfiles(boot.piProfiles?.length ? boot.piProfiles : [PI_DEFAULT_PROFILE], PI_DEFAULT_PROFILE));
        applyHerdrBootstrap(boot);
        setSkills(boot.skills);
        setTagsList(boot.tags);

        // Project-scoped cheap reads — fire in parallel, don't block the spinner.
        // (The Schedule tab self-fetches its own runs when opened.)
        if (activeProjectId) {
          getProviderDivergence<ProviderDivergence>(activeProjectId)
            .then((div) => { if (!cancelled) setProviderDivergence(div); })
            .catch(() => { /* non-fatal */ });

          apiFetch<SettingsProjectRow[]>("/api/projects")
            .then((projects) => {
              if (cancelled) return;
              const project = projects.find((p) => p.id === activeProjectId);
              if (project) {
                setProjectSettings(hydrateProjectSettings(project, data, activeProjectId));
              }
            })
            .catch(() => { /* use defaults for project settings */ });
        }
      } catch {
        // Use defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // --- Deferred path: heavy / secondary status data. Streams in after the panel is
    // interactive; each populates a status badge or a non-default tab that handles its
    // empty/initial state gracefully. ---
    function loadDeferred() {
      getAgentProfilesHealth<{ profiles: AgentProfileHealth[] }>()
        .then((d) => { if (!cancelled) setProfileHealth(d.profiles); })
        .catch(() => { /* non-fatal */ });

      fetchMcpHealth<McpHealth>()
        .then((d) => { if (!cancelled) setMcpHealth(d); })
        .catch(() => { /* non-fatal */ });

      // Single batched request replaces the per-skill install-status N+1.
      apiFetch<Record<string, boolean>>("/api/agent-skills/install-status")
        .then((map) => { if (!cancelled) setInstalledSkills(map); })
        .catch(() => { /* non-fatal */ });

      if (activeProjectId) {
        apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${activeProjectId}/branches`)
          .then((b) => { if (!cancelled) setProjectBranches(b); })
          .catch(() => { if (!cancelled) setProjectBranches(null); });
      }
    }

    // Run the deferred probes only after the critical bootstrap resolves, so the heavy
    // status requests don't compete for the connection pool during first paint.
    void loadCore().finally(() => { if (!cancelled) loadDeferred(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return herdr;
}
