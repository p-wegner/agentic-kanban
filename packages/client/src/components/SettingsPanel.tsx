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
}

const DEFAULT_SETTINGS: Settings = {
  agent_command: "",
  agent_args: "",
  output_parser: "true",
  mock_agent: "false",
  skip_permissions: "false",
  claude_profile: "",
};

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(384px,100vw)] bg-white shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {loading ? (
            <div className="text-sm text-gray-500">Loading...</div>
          ) : (
            <>
              {/* Agent Command */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Agent Command
                </label>
                <input
                  type="text"
                  value={settings.agent_command || ""}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, agent_command: e.target.value }))
                  }
                  placeholder="claude"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Binary name or path. Leave empty for default (claude).
                  Examples: claude, claude-glm, /usr/local/bin/claude
                </p>
              </div>

              {/* Claude Profile */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Claude Profile
                </label>
                <select
                  value={settings.claude_profile || ""}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, claude_profile: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Default (no profile)</option>
                  {profiles.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Passes <code className="text-xs">--settings</code> to Claude Code pointing to
                  the corresponding <code className="text-xs">~/.claude/settings_*.json</code> file.
                </p>
              </div>

              {/* Agent Args */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Additional Arguments
                </label>
                <input
                  type="text"
                  value={settings.agent_args || ""}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, agent_args: e.target.value }))
                  }
                  placeholder="--model opus --settings .claude/settings.json"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Extra CLI arguments passed to the agent command.
                  Arguments are shell-split (supports quoting).
                </p>
              </div>

              {/* Output Parser */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Output Parsing
                </label>
                <select
                  value={settings.output_parser || "true"}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, output_parser: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="true">Parse stream-json output</option>
                  <option value="false">Show raw output</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  When enabled, the terminal view parses Claude&apos;s JSON output
                  and displays structured info (model, tools, cost, etc.).
                </p>
              </div>

              {/* Skip Permissions */}
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.skip_permissions === "true"}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, skip_permissions: e.target.checked ? "true" : "false" }))
                    }
                    className="rounded border-gray-300"
                  />
                  Skip Permissions (<code className="text-xs">--dangerously-skip-permissions</code>)
                </label>
                <p className="text-xs text-gray-500 mt-1">
                  Bypass all permission checks. Recommended only for sandboxes
                  with no internet access.
                </p>
              </div>

              {/* Mock Agent */}
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.mock_agent === "true"}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, mock_agent: e.target.checked ? "true" : "false" }))
                    }
                    className="rounded border-gray-300"
                  />
                  Mock Agent
                </label>
                <p className="text-xs text-gray-500 mt-1">
                  Use a mock agent that emits fake stream-json output instead of
                  launching Claude Code. Useful for testing and development.
                </p>
              </div>

              {/* Info box */}
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                <p className="text-xs text-blue-700">
                  Changes apply to new agent sessions. Running sessions are not affected.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
          >
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
  );
}
