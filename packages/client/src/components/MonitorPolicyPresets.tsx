import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { setSettings } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";
import { BUILTIN_PRESETS, deriveRefillFocus, presetMatchesConfig, presetsKey } from "../lib/strategy-targets.js";
import type { MonitorPolicyPreset, StrategyConfig } from "../lib/strategy-targets.js";

export function MonitorPolicyPresets({
  projectId,
  config,
  onApply,
}: {
  projectId: string;
  config: StrategyConfig;
  onApply: (preset: MonitorPolicyPreset) => void;
}) {
  const [customPresets, setCustomPresets] = useState<MonitorPolicyPreset[]>([]);
  const [savingName, setSavingName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const key = presetsKey(projectId);

  useEffect(() => {
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((settings) => {
        const raw = settings[key];
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setCustomPresets(parsed);
        }
      })
      .catch(() => {});
  }, [key]);

  const allPresets = [...BUILTIN_PRESETS, ...customPresets];
  const refillFocus = deriveRefillFocus(config.segments);
  const activePreset = allPresets.find((p) => presetMatchesConfig(p, config)) ?? null;

  const hasDrift = activePreset !== null
    ? false
    : allPresets.some((p) => {
        return (
          p.activeAgentsTarget === config.activeAgentsTarget ||
          p.backlogFloor === config.backlogFloor ||
          p.maxNewStartsPerCycle === config.maxNewStartsPerCycle
        );
      });

  async function saveCurrentAsPreset() {
    if (!savingName.trim()) return;
    setSaving(true);
    const newPreset: MonitorPolicyPreset = {
      id: `custom-${Date.now()}`,
      name: savingName.trim(),
      activeAgentsTarget: config.activeAgentsTarget,
      backlogFloor: config.backlogFloor,
      maxNewStartsPerCycle: config.maxNewStartsPerCycle,
      refillFocus,
    };
    const next = [...customPresets, newPreset];
    try {
      await setSettings({ [key]: JSON.stringify(next) });
      setCustomPresets(next);
      setSavingName("");
      setShowSaveForm(false);
      showToast(`Preset "${newPreset.name}" saved`, "success");
    } catch {
      showToast("Failed to save preset", "error");
    } finally {
      setSaving(false);
    }
  }

  async function deletePreset(id: string) {
    const next = customPresets.filter((p) => p.id !== id);
    try {
      await setSettings({ [key]: JSON.stringify(next) });
      setCustomPresets(next);
    } catch {
      showToast("Failed to delete preset", "error");
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Monitor policy presets</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">Apply a named preset to update agent target, backlog floor, starts/cycle, and refill focus.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowSaveForm((v) => !v)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          title="Save current values as preset"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3}><path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      {activePreset ? (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-green-50 px-2.5 py-1.5 text-xs font-medium text-green-700 dark:bg-green-950/40 dark:text-green-300">
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
          Active: <span className="font-semibold">{activePreset.name}</span>
        </div>
      ) : hasDrift ? (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
          Custom values (drift from any preset)
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          No preset active
        </div>
      )}

      <div className="space-y-1.5">
        {allPresets.map((preset) => {
          const isActive = activePreset?.id === preset.id;
          const isCustom = !BUILTIN_PRESETS.some((b) => b.id === preset.id);
          return (
            <div
              key={preset.id}
              className={`flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors ${isActive ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30" : "border-gray-100 bg-gray-50 hover:bg-gray-100 dark:border-gray-800 dark:bg-gray-950 dark:hover:bg-gray-800"}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">{preset.name}</span>
                  {isCustom && <span className="rounded px-1 py-0.5 text-[10px] bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400">custom</span>}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  {preset.activeAgentsTarget} agents · floor {preset.backlogFloor} · {preset.maxNewStartsPerCycle} starts/cycle · {preset.refillFocus}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isActive && (
                  <button
                    type="button"
                    onClick={() => onApply(preset)}
                    className="rounded px-2 py-0.5 text-[11px] font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40 transition-colors"
                  >
                    Apply
                  </button>
                )}
                {isCustom && (
                  <button
                    type="button"
                    onClick={() => deletePreset(preset.id)}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 transition-colors"
                    title="Delete preset"
                  >
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showSaveForm && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsPreset(); if (e.key === "Escape") setShowSaveForm(false); }}
            placeholder="Preset name..."
            className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            autoFocus
          />
          <button
            type="button"
            onClick={saveCurrentAsPreset}
            disabled={saving || !savingName.trim()}
            className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setShowSaveForm(false)}
            className="rounded-md px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
