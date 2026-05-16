import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface SettingsPanelProps {
  onClose: () => void;
}

interface Settings {
  agent_command?: string;
  agent_args?: string;
  output_parser?: string;
  mock_agent?: string;
  skip_permissions?: string;
  claude_profile?: string;
  permission_prompt_tool?: string;
  auto_review?: string;
  auto_merge?: string;
  resume_with_new_model?: string;
}

const DEFAULT_SETTINGS: Settings = {
  agent_command: "",
  agent_args: "",
  output_parser: "true",
  mock_agent: "false",
  skip_permissions: "false",
  claude_profile: "",
  permission_prompt_tool: "true",
  auto_review: "true",
  auto_merge: "true",
  resume_with_new_model: "false",
};

type Tab = "agent" | "workflow" | "ui" | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflow", label: "Workflow" },
  { id: "ui", label: "UI" },
  { id: "advanced", label: "Advanced" },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`space-y-0.5 ${disabled ? "opacity-50" : ""}`}>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="rounded border-gray-300"
        />
        {label}
      </label>
      {hint && <p className="text-xs text-gray-500 pl-5">{hint}</p>}
    </div>
  );
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("agent");

  useEffect(() => {
    async function load() {
      try {
        const [data, profileData] = await Promise.all([
          apiFetch<Record<string, string>>("/api/preferences/settings"),
          apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles"),
        ]);
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setProfiles(profileData.profiles);
      } catch {
        // Use defaults
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      showToast("Settings saved", "success");
      onClose();
    } catch {
      showToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof Settings) => (value: string) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const setBool = (key: keyof Settings) => (checked: boolean) =>
    setSettings((s) => ({ ...s, [key]: checked ? "true" : "false" }));

  const autoReviewOn = settings.auto_review !== "false";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl flex flex-col max-h-[85vh] animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Settings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-sm text-gray-500">Loading...</div>
          ) : (
            <div className="space-y-5">
              {/* Agent tab */}
              {tab === "agent" && (
                <>
                  <Field label="Agent Command" hint="Binary name or path. Leave empty for default (claude). Examples: claude, claude-glm, /usr/local/bin/claude">
                    <input
                      type="text"
                      value={settings.agent_command || ""}
                      onChange={(e) => set("agent_command")(e.target.value)}
                      placeholder="claude"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </Field>
                  <Field label="Claude Profile" hint={`Passes --settings to Claude Code pointing to ~/.claude/settings_*.json`}>
                    <select
                      value={settings.claude_profile || ""}
                      onChange={(e) => set("claude_profile")(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">Default (no profile)</option>
                      {profiles.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Additional Arguments" hint="Extra CLI arguments passed to the agent command. Arguments are shell-split (supports quoting).">
                    <input
                      type="text"
                      value={settings.agent_args || ""}
                      onChange={(e) => set("agent_args")(e.target.value)}
                      placeholder="--model opus --settings .claude/settings.json"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </Field>
                  <Toggle
                    checked={settings.mock_agent === "true"}
                    onChange={setBool("mock_agent")}
                    label="Mock Agent"
                    hint="Use a mock agent that emits fake stream-json output instead of launching Claude Code. Useful for testing and development."
                  />
                </>
              )}

              {/* Workflow tab */}
              {tab === "workflow" && (
                <>
                  <Toggle
                    checked={autoReviewOn}
                    onChange={setBool("auto_review")}
                    label="Auto Code Review"
                    hint="When an agent commits and exits successfully, automatically launch a review agent that checks the diff for issues."
                  />
                  <div className={`pl-5 space-y-3 border-l-2 ${autoReviewOn ? "border-blue-200" : "border-gray-100"}`}>
                    <Toggle
                      checked={settings.auto_merge !== "false"}
                      onChange={setBool("auto_merge")}
                      label="Auto-merge after review"
                      hint="Merge the branch and close the workspace automatically once the review agent passes. When disabled, the issue moves to AI Reviewed and waits for manual merge."
                      disabled={!autoReviewOn}
                    />
                  </div>
                  <Toggle
                    checked={settings.resume_with_new_model === "true"}
                    onChange={setBool("resume_with_new_model")}
                    label="Use new profile on resume"
                    hint="When continuing a chat, start a fresh session using the current profile instead of resuming the previous one. Use this when switching providers via a different Claude profile."
                  />
                </>
              )}

              {/* UI tab */}
              {tab === "ui" && (
                <Field label="Output Parsing" hint={`When enabled, the terminal view parses Claude's stream-json output and displays structured info. "Minimal" shows a compact activity timeline.`}>
                  <select
                    value={settings.output_parser || "true"}
                    onChange={(e) => set("output_parser")(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="true">Parse stream-json output</option>
                    <option value="minimal">Minimal activity view</option>
                    <option value="false">Show raw output</option>
                  </select>
                </Field>
              )}

              {/* Advanced tab */}
              {tab === "advanced" && (
                <>
                  <Toggle
                    checked={settings.skip_permissions === "true"}
                    onChange={setBool("skip_permissions")}
                    label="Skip Permissions (--dangerously-skip-permissions)"
                    hint="Bypass all permission checks. Recommended only for sandboxes with no internet access."
                  />
                  <Toggle
                    checked={settings.permission_prompt_tool !== "false"}
                    onChange={setBool("permission_prompt_tool")}
                    label="Permission Prompt Tool"
                    hint="Pass --permission-prompt-tool to Claude Code. Routes tool approval requests through the UI instead of the terminal."
                  />
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200">
          <p className="text-xs text-gray-400">Changes apply to new agent sessions only.</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
