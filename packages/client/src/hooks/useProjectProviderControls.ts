import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "../lib/api.js";
import { setSettings as savePreferences } from "../lib/settingsStore.js";
import { showToast } from "../lib/toast.js";
import { normalizeConfig, setProviderFillPolicy, clearProviderFillPolicy, settingsKey, type ConcreteProvider } from "../lib/strategy-targets.js";
import { allowedProfilesPrefKey, serializeProfileAllowlist, type AllowedProfile } from "@agentic-kanban/shared/lib/profile-allowlist";
import type { Settings } from "../lib/settings-shared.js";

export type ProviderDivergence = {
  hasBullseye: boolean;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
  diverged: boolean;
};

export interface ProjectProviderControls {
  providerDivergence: ProviderDivergence | null;
  /** Exposed (not just `refetchProviderDivergence`) so the panel's cancellable
   *  bootstrap effect can fetch this itself and guard the `cancelled` flag,
   *  the way it does for every other bootstrap field. */
  setProviderDivergence: Dispatch<SetStateAction<ProviderDivergence | null>>;
  savingProjectProvider: boolean;
  savingAllowedProfiles: boolean;
  refetchProviderDivergence: () => Promise<void>;
  handleProjectProviderChange: (provider: ConcreteProvider | null, profileName: string) => Promise<void>;
  handleAllowedProfilesChange: (entries: AllowedProfile[]) => Promise<void>;
}

/**
 * Owns the Settings → Agent tab's per-project provider controls: the Strategy-
 * Bullseye divergence badge, the simple per-project provider override, and the
 * per-project profile allowlist. Extracted verbatim from SettingsPanel — its
 * external inputs are the active project id and the panel's `settings` state
 * (read for the current Strategy config, written back after each save so the
 * panel doesn't refetch its whole settings blob).
 */
export function useProjectProviderControls(
  activeProjectId: string | null | undefined,
  settings: Settings,
  setSettings: Dispatch<SetStateAction<Settings>>,
): ProjectProviderControls {
  const [providerDivergence, setProviderDivergence] = useState<ProviderDivergence | null>(null);
  const [savingProjectProvider, setSavingProjectProvider] = useState(false);
  const [savingAllowedProfiles, setSavingAllowedProfiles] = useState(false);

  async function refetchProviderDivergence() {
    if (!activeProjectId) return;
    try {
      const div = await apiFetch<ProviderDivergence>(`/api/preferences/provider-divergence?projectId=${activeProjectId}`);
      setProviderDivergence(div);
    } catch { /* non-fatal */ }
  }

  /**
   * Per-project profile allowlist — a HARD constraint, unlike the provider control
   * below it. Written to `allowed_profiles_<projectId>` in the canonical serialization
   * so the server's `parseProfileAllowlist` and this editor cannot drift.
   *
   * An empty selection stores `[]`, which the parser reads as "restriction lifted".
   * Deleting the row would mean the same thing, but writing `[]` keeps the preference
   * visible in an exported config, so a project that USED to be restricted doesn't look
   * like one that never was.
   */
  async function handleAllowedProfilesChange(entries: AllowedProfile[]) {
    if (!activeProjectId || savingAllowedProfiles) return;
    setSavingAllowedProfiles(true);
    try {
      const key = allowedProfilesPrefKey(activeProjectId);
      const serialized = serializeProfileAllowlist(entries);
      await savePreferences({ [key]: serialized });
      setSettings((s) => ({ ...s, [key]: serialized }));
      showToast(
        entries.length === 0
          ? "Project may use any profile"
          : `Project restricted to ${entries.length} profile${entries.length === 1 ? "" : "s"}`,
        "success",
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update allowed profiles", "error");
    } finally {
      setSavingAllowedProfiles(false);
    }
  }

  // First-class per-project provider control (#925): persist the selection as a
  // single Strategy-Bullseye `fill` policy on board_strategy_<projectId>, NOT the
  // global provider pref — so the write never trips the divergence guard and the
  // simple control round-trips with the advanced Provider-policies editor.
  async function handleProjectProviderChange(provider: ConcreteProvider | null, profileName: string) {
    if (!activeProjectId || savingProjectProvider) return;
    setSavingProjectProvider(true);
    try {
      const key = settingsKey(activeProjectId);
      // `board_strategy_<projectId>` is a dynamic per-project key, not a static
      // member of the Settings type — index it the same way the verify_script_<id>
      // save path does.
      const rawCurrent = settings[key as keyof Settings];
      const currentConfig = normalizeConfig(rawCurrent ? JSON.parse(rawCurrent) : null);
      const nextConfig = provider
        ? setProviderFillPolicy(currentConfig, provider, profileName)
        : clearProviderFillPolicy(currentConfig);
      const serialized = JSON.stringify(nextConfig);
      await savePreferences({ [key]: serialized });
      setSettings((s) => ({ ...s, [key]: serialized }));
      await refetchProviderDivergence();
      showToast(provider ? "Project provider updated" : "Project now uses the global default provider", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update project provider", "error");
    } finally {
      setSavingProjectProvider(false);
    }
  }

  return {
    providerDivergence,
    setProviderDivergence,
    savingProjectProvider,
    savingAllowedProfiles,
    refetchProviderDivergence,
    handleProjectProviderChange,
    handleAllowedProfilesChange,
  };
}
