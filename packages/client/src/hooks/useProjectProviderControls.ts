import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { apiFetch } from "../lib/api.js";
import { setSettings as savePreferences } from "../lib/settingsStore.js";
import { showToast } from "../lib/toast.js";
import { normalizeConfig, setProviderFillPolicy, clearProviderFillPolicy, settingsKey, type ConcreteProvider } from "../lib/strategy-targets.js";
import {
  allowedProfilesPrefKey,
  DEFAULT_POOL_EXHAUSTED_PCT,
  parseRoster,
  reserveAllowedPrefKey,
  rosterExhaustedPctPrefKey,
  rosterPrefKey,
  serializeRoster,
  type ProfileRole,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import { applyRoleChange, removeFromRoster, type RosterDraftEntry } from "../lib/rosterEditor.js";
import type { RosterCandidate } from "../components/settings/ProjectRosterEditor.js";
import type { Settings } from "../lib/settings-shared.js";

export type ProviderDivergence = {
  hasBullseye: boolean;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
  diverged: boolean;
};

/**
 * The per-project ROSTER controls (#1028) — one object rather than six props, because they
 * are one control surface and threading them individually through `SettingsPanel` →
 * `AgentSettings` → the editor is how a prop list stops being readable.
 */
export interface ProjectRosterControls {
  /** The project's stored roster, read through the sanctioned key builders. */
  entries: RosterDraftEntry[];
  reserveAllowed: boolean;
  exhaustedPct: number;
  saving: boolean;
  /** The last refused widening, so the editor can explain rather than silently ignore. */
  rejection: string | null;
  /** Bumped after every successful write, so the roster read model refetches. */
  reloadKey: number;
  onRoleChange: (candidate: RosterCandidate, role: ProfileRole | null) => void;
  onReserveAllowedChange: (allowed: boolean) => void;
  onExhaustedPctChange: (pct: number) => void;
}

export interface ProjectProviderControls {
  providerDivergence: ProviderDivergence | null;
  /** Exposed (not just `refetchProviderDivergence`) so the panel's cancellable
   *  bootstrap effect can fetch this itself and guard the `cancelled` flag,
   *  the way it does for every other bootstrap field. */
  setProviderDivergence: Dispatch<SetStateAction<ProviderDivergence | null>>;
  savingProjectProvider: boolean;
  refetchProviderDivergence: () => Promise<void>;
  handleProjectProviderChange: (provider: ConcreteProvider | null, profileName: string) => Promise<void>;
  roster: ProjectRosterControls;
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
  const [savingRoster, setSavingRoster] = useState(false);
  const [rosterRejection, setRosterRejection] = useState<string | null>(null);
  const [rosterReloadKey, setRosterReloadKey] = useState(0);

  // The stored roster, with the same fallback the resolver uses: a project that only ever
  // had an `allowed_profiles_<id>` value reads as an all-`pool` roster, so migrating is a
  // read, not a rewrite. Editing then writes `roster_<id>`, which wins from that point on.
  const rosterKey = activeProjectId ? rosterPrefKey(activeProjectId) : "";
  const rosterRaw = activeProjectId ? (settings[rosterKey as keyof Settings] as string | undefined) : undefined;
  const allowlistRaw = activeProjectId
    ? (settings[allowedProfilesPrefKey(activeProjectId) as keyof Settings] as string | undefined)
    : undefined;
  const rosterEntries: RosterDraftEntry[] = ((rosterRaw ?? "").trim()
    ? parseRoster(rosterRaw, "roster")
    // The legacy value read AS a roster (all `pool`) — the same read-time projection
    // `resolveProjectRoster` performs, rather than a second interpretation of it.
    : parseRoster(allowlistRaw, "allowed_profiles")
  ).entries.map((e) => ({ provider: e.provider, name: e.name, role: e.role }));

  const reserveAllowedRaw = activeProjectId
    ? (settings[reserveAllowedPrefKey(activeProjectId) as keyof Settings] as string | undefined)
    : undefined;
  const exhaustedPctRaw = activeProjectId
    ? (settings[rosterExhaustedPctPrefKey(activeProjectId) as keyof Settings] as string | undefined)
    : undefined;
  const parsedPct = Number.parseFloat((exhaustedPctRaw ?? "").trim());

  /** One roster-shaped preference write, with the toast and the refetch every one needs. */
  async function saveRosterPref(key: string, value: string, message: string) {
    if (!activeProjectId || savingRoster) return;
    setSavingRoster(true);
    try {
      await savePreferences({ [key]: value });
      setSettings((s) => ({ ...s, [key]: value }));
      setRosterRejection(null);
      setRosterReloadKey((k) => k + 1);
      showToast(message, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to update the roster", "error");
    } finally {
      setSavingRoster(false);
    }
  }

  /**
   * Set (or clear) one profile's role. A widening is refused HERE and never sent — the
   * server refuses it too, but a UI that posts a write it knows will be rejected turns an
   * explainable rule into a round trip and an error toast.
   */
  function handleRosterRoleChange(candidate: RosterCandidate, role: ProfileRole | null) {
    if (!activeProjectId) return;
    if (role === null) {
      void saveRosterPref(
        rosterPrefKey(activeProjectId),
        serializeRoster(removeFromRoster(rosterEntries, candidate.id)),
        `${candidate.id} removed from the roster`,
      );
      return;
    }
    const result = applyRoleChange(rosterEntries, candidate, role, candidate.globalRole);
    if (result.rejected) {
      setRosterRejection(result.rejected);
      showToast(result.rejected, "error");
      return;
    }
    void saveRosterPref(
      rosterPrefKey(activeProjectId),
      serializeRoster(result.entries),
      `${candidate.id} is now ${role} for this project`,
    );
  }


  async function refetchProviderDivergence() {
    if (!activeProjectId) return;
    try {
      const div = await apiFetch<ProviderDivergence>(`/api/preferences/provider-divergence?projectId=${activeProjectId}`);
      setProviderDivergence(div);
    } catch { /* non-fatal */ }
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
    refetchProviderDivergence,
    handleProjectProviderChange,
    roster: {
      entries: rosterEntries,
      reserveAllowed: (reserveAllowedRaw ?? "").trim().toLowerCase() === "true",
      // An unparseable or out-of-range stored value shows the DEFAULT, matching
      // `resolvePoolExhaustedPct` — a control that displayed the broken value would suggest
      // the board is using it, which it is not.
      exhaustedPct: Number.isFinite(parsedPct) && parsedPct > 0 && parsedPct <= 100 ? parsedPct : DEFAULT_POOL_EXHAUSTED_PCT,
      saving: savingRoster,
      rejection: rosterRejection,
      reloadKey: rosterReloadKey,
      onRoleChange: handleRosterRoleChange,
      onReserveAllowedChange: (allowed: boolean) => {
        if (!activeProjectId) return;
        void saveRosterPref(
          reserveAllowedPrefKey(activeProjectId),
          allowed ? "true" : "false",
          allowed ? "This project may reach for a reserve profile" : "Reserve profiles withheld from this project",
        );
      },
      onExhaustedPctChange: (pct: number) => {
        if (!activeProjectId) return;
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return;
        void saveRosterPref(
          rosterExhaustedPctPrefKey(activeProjectId),
          String(pct),
          `Pool profiles count as exhausted at ${pct}%`,
        );
      },
    },
  };
}
