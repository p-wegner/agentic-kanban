import { useEffect, useMemo, useState } from "react";
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";
import { apiFetch } from "../../lib/api.js";
import { getSettings, invalidateSettings } from "../../lib/settingsStore.js";
import { showToast } from "../Toast.js";
import {
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  PI_DEFAULT_PROFILE,
  CollapsibleSection,
  Field,
  type AgentProvider,
} from "../SettingsPanel.shared.js";
import {
  agentPresetsKey,
  sanitizeAgentPresets,
  upsertAgentPreset,
  deleteAgentPreset,
  type AgentPreset,
} from "../../lib/agentPresets.js";

type AgentPresetsEditorProps = {
  activeProjectId?: string | null;
  profiles: string[];
  codexProfiles: string[];
  copilotProfiles: string[];
  piProfiles: string[];
};

const EMPTY_DRAFT = { name: "", provider: "claude" as AgentProvider, profile: "", model: "" };

export function AgentPresetsEditor({ activeProjectId, profiles, codexProfiles, copilotProfiles, piProfiles }: AgentPresetsEditorProps) {
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const prefKey = useMemo(() => (activeProjectId ? agentPresetsKey(activeProjectId) : ""), [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    setLoaded(false);
    getSettings()
      .then((settings) => setPresets(sanitizeAgentPresets(settings[agentPresetsKey(activeProjectId)])))
      .catch(() => setPresets([]))
      .finally(() => setLoaded(true));
  }, [activeProjectId]);

  if (!activeProjectId) {
    return (
      <CollapsibleSection title="Agent Presets" configured={false} defaultOpen={false}>
        <p className="text-xs text-gray-500 dark:text-gray-400">Select a project to manage agent presets.</p>
      </CollapsibleSection>
    );
  }

  const profileOptions =
    draft.provider === "codex"
      ? codexProfiles.length ? codexProfiles : [CODEX_DEFAULT_PROFILE]
      : draft.provider === "copilot"
      ? copilotProfiles.length ? copilotProfiles : [COPILOT_DEFAULT_PROFILE]
      : draft.provider === "pi"
      ? piProfiles.length ? piProfiles : [PI_DEFAULT_PROFILE]
      : profiles;
  const modelOptions = draft.provider === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  const supportsModel = draft.provider === "claude" || draft.provider === "codex";

  async function persist(next: AgentPreset[], message: string) {
    if (!prefKey) return false;
    setSaving(true);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ [prefKey]: JSON.stringify(next) }),
      });
      invalidateSettings();
      setPresets(next);
      showToast(message, "success");
      return true;
    } catch {
      showToast("Failed to save agent preset", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function startEdit(preset: AgentPreset) {
    setEditingId(preset.id);
    setDraft({
      name: preset.name,
      provider: preset.provider,
      profile: preset.profile ?? "",
      model: preset.model ?? "",
    });
  }

  function resetDraft() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function handleSave() {
    const name = draft.name.trim();
    if (!name) return;
    // When editing and renaming, drop the old entry so the upsert (keyed by name) doesn't duplicate.
    let base = presets;
    if (editingId) {
      const editing = presets.find((p) => p.id === editingId);
      if (editing && editing.name.toLowerCase() !== name.toLowerCase()) {
        base = deleteAgentPreset(presets, editingId);
      }
    }
    const next = upsertAgentPreset(base, name, {
      provider: draft.provider,
      profile: draft.profile || undefined,
      model: supportsModel ? draft.model || undefined : undefined,
    });
    const saved = await persist(next, `Saved preset "${name}"`);
    if (saved) resetDraft();
  }

  async function handleDelete(preset: AgentPreset) {
    const next = deleteAgentPreset(presets, preset.id);
    const deleted = await persist(next, `Deleted preset "${preset.name}"`);
    if (deleted && editingId === preset.id) resetDraft();
  }

  function presetSummary(preset: AgentPreset): string {
    const providerLabel = preset.provider === "codex" ? "Codex" : preset.provider === "copilot" ? "Copilot" : preset.provider === "pi" ? "Pi" : "Claude";
    const parts = [providerLabel];
    if (preset.profile) parts.push(preset.profile);
    if (preset.model) parts.push(preset.model);
    return parts.join(" · ");
  }

  return (
    <CollapsibleSection title="Agent Presets" configured={presets.length > 0} defaultOpen={presets.length > 0}>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Named provider + profile + model bundles for this project. Pick one in the New Workspace dialog to fill the agent
        fields in one click (you can still override each field manually).
      </p>
      {!loaded ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 italic">Loading presets…</p>
      ) : presets.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500 italic">No presets yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-md">
          {presets.map((preset) => (
            <li key={preset.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{preset.name}</div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{presetSummary(preset)}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => startEdit(preset)}
                  disabled={saving}
                  className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(preset)}
                  disabled={saving}
                  className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-2 border-t border-gray-100 dark:border-gray-800 pt-2">
        <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          {editingId ? "Edit preset" : "New preset"}
        </div>
        <Field label="Name">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="e.g. Claude Opus, Codex fast"
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          />
        </Field>
        <Field label="Provider">
          <select
            value={draft.provider}
            onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value as AgentProvider, profile: "", model: "" }))}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="copilot">Copilot</option>
            <option value="pi">Pi</option>
          </select>
        </Field>
        <Field label="Profile">
          <select
            value={draft.profile}
            onChange={(e) => setDraft((d) => ({ ...d, profile: e.target.value }))}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">Default</option>
            {profileOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
        {supportsModel && (
          <Field label="Model">
            <select
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
            >
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !draft.name.trim()}
            className="text-sm bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50"
          >
            {editingId ? "Save preset" : "Add preset"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetDraft}
              className="text-sm text-gray-500 dark:text-gray-400 px-3 py-1.5 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
