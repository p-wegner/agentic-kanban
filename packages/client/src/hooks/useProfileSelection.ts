import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { getSettings } from "../lib/settingsStore.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  defaultSelectedProfile,
  uniqueProfileOptions,
  type ProfileOption,
} from "../lib/workspace-helpers.js";

interface UseProfileSelectionResult {
  prefs: Record<string, string>;
  requiresReview: boolean;
  setRequiresReview: React.Dispatch<React.SetStateAction<boolean>>;
  selectedProfile: string;
  setSelectedProfile: React.Dispatch<React.SetStateAction<string>>;
  selectedModel: string;
  setSelectedModel: React.Dispatch<React.SetStateAction<string>>;
  availableProfileOptions: ProfileOption[];
}

/**
 * Profile/model quick-launch selection state for the workspace panel:
 * global preference defaults plus the available Claude/Codex/Copilot
 * profile options, refreshed whenever the panel switches to another issue.
 */
export function useProfileSelection(issueId: string): UseProfileSelectionResult {
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [requiresReview, setRequiresReview] = useState(false);
  const [availableProfileOptions, setAvailableProfileOptions] = useState<ProfileOption[]>([
    { provider: "codex", name: CODEX_DEFAULT_PROFILE },
    { provider: "copilot", name: COPILOT_DEFAULT_PROFILE },
  ]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");

  useEffect(() => {
    getSettings()
      .then((s) => {
        setPrefs(s);
        setRequiresReview(s.auto_review !== "false");
        setSelectedProfile(defaultSelectedProfile(s));
        setSelectedModel(s.default_model || "");
      })
      .catch(() => {});
    Promise.all([
      apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles").catch(() => ({ profiles: [CODEX_DEFAULT_PROFILE] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [COPILOT_DEFAULT_PROFILE] })),
    ]).then(([claudeData, codexData, copilotData]) => {
      setAvailableProfileOptions(uniqueProfileOptions([
        ...claudeData.profiles.map((name) => ({ provider: "claude" as const, name })),
        { provider: "codex" as const, name: CODEX_DEFAULT_PROFILE },
        ...codexData.profiles.map((name) => ({ provider: "codex" as const, name })),
        { provider: "copilot" as const, name: COPILOT_DEFAULT_PROFILE },
        ...copilotData.profiles.map((name) => ({ provider: "copilot" as const, name })),
      ]));
    }).catch(() => {});
  }, [issueId]);

  return {
    prefs,
    requiresReview,
    setRequiresReview,
    selectedProfile,
    setSelectedProfile,
    selectedModel,
    setSelectedModel,
    availableProfileOptions,
  };
}
