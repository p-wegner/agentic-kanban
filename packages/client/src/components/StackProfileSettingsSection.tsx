import { useEffect, useState } from "react";
import type { StackProfile, StackProfileResponse } from "@agentic-kanban/shared";
import { apiFetch, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { CollapsibleSection } from "./SettingsPanel.shared.js";

interface StackProfileSettingsSectionProps {
  projectId: string;
}

/** Editable string fields rendered as inputs, in display order. */
const STRING_FIELDS: Array<{ key: keyof StackProfile; label: string; placeholder: string }> = [
  { key: "stack", label: "Stack", placeholder: "node" },
  { key: "packageManager", label: "Package manager", placeholder: "pnpm" },
  { key: "installCommand", label: "Install", placeholder: "pnpm install" },
  { key: "buildCommand", label: "Build", placeholder: "pnpm run build" },
  { key: "testCommand", label: "Test", placeholder: "pnpm test" },
  { key: "quickTestCommand", label: "Quick test", placeholder: "pnpm test:mine" },
  { key: "lintCommand", label: "Lint", placeholder: "pnpm run lint" },
  { key: "typecheckCommand", label: "Typecheck", placeholder: "tsc --noEmit" },
  { key: "devCommand", label: "Dev", placeholder: "pnpm dev" },
  { key: "devHealthUrl", label: "Dev health URL", placeholder: "http://localhost:5173" },
  { key: "testDir", label: "Test directory", placeholder: "src/__tests__" },
  { key: "testRunner", label: "Test runner", placeholder: "vitest" },
];

export function StackProfileSettingsSection({ projectId }: StackProfileSettingsSectionProps) {
  const [profile, setProfile] = useState<StackProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await apiFetch<StackProfileResponse>(
        `/api/projects/${projectId}/stack-profile${refresh ? "?refresh=true" : ""}`,
      );
      setProfile(res.profile);
    } catch {
      showToast("Failed to load stack profile", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function update<K extends keyof StackProfile>(key: K, value: StackProfile[K]) {
    setProfile((p) => (p ? { ...p, [key]: value } : p));
  }

  async function save() {
    if (!profile) return;
    setSaving(true);
    try {
      const res = await apiPut<StackProfileResponse>(`/api/projects/${projectId}/stack-profile`, profile);
      setProfile(res.profile);
      showToast("Stack profile saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save stack profile", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleSection title="Stack Profile" configured={!!profile?.stack} defaultOpen={false}>
      <p className="text-xs text-gray-500">
        The durable per-project stack descriptor the feedback harness reads (build/test/lint/typecheck/dev
        commands, monorepo layout, dev port). Detected at registration; override any field below.
      </p>

      {loading && <p className="text-xs text-gray-500">Loading…</p>}

      {!loading && !profile && <p className="text-xs text-gray-500">No stack profile yet.</p>}

      {!loading && profile && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">source: {profile.source}</span>
            {profile.isMonorepo && (
              <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">
                monorepo{profile.workspaces.length ? `: ${profile.workspaces.join(", ")}` : ""}
              </span>
            )}
            {profile.detectedMarkers.length > 0 && (
              <span className="truncate">markers: {profile.detectedMarkers.join(", ")}</span>
            )}
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            {STRING_FIELDS.map(({ key, label, placeholder }) => (
              <label key={key} className="block">
                <span className="block text-xs text-gray-500 mb-1">{label}</span>
                <input
                  value={(profile[key] as string | null) ?? ""}
                  onChange={(e) => update(key, (e.target.value || null) as StackProfile[typeof key])}
                  placeholder={placeholder}
                  className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono dark:bg-gray-900 dark:text-gray-100"
                />
              </label>
            ))}
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">Dev port</span>
              <input
                type="number"
                value={profile.devPort ?? ""}
                onChange={(e) => update("devPort", e.target.value ? Number(e.target.value) : null)}
                placeholder="5173"
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono dark:bg-gray-900 dark:text-gray-100"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={profile.isWeb}
              onChange={(e) => update("isWeb", e.target.checked)}
            />
            Serves a web UI (isWeb)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={profile.isMonorepo}
              onChange={(e) => update("isMonorepo", e.target.checked)}
            />
            Monorepo
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save override"}
            </button>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {refreshing ? "Re-detecting…" : "Re-detect"}
            </button>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}
