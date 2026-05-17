import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface SettingsPanelProps {
  onClose: () => void;
  activeProjectId?: string | null;
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
  review_auto_fix?: string;
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
  review_auto_fix: "true",
  resume_with_new_model: "false",
};

type Tab = "agent" | "workflow" | "skills" | "ui" | "project" | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflow", label: "Workflow" },
  { id: "skills", label: "Skills" },
  { id: "ui", label: "UI" },
  { id: "project", label: "Project" },
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

function EditSkillForm({ skill, isNew, onSave, onCancel }: {
  skill: { id?: string; name: string; description: string; prompt: string; model: string | null; projectId?: string | null };
  isNew?: boolean;
  onSave: (data: { name: string; description: string; prompt: string; model: string; projectId?: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [prompt, setPrompt] = useState(skill.prompt);
  const [model, setModel] = useState(skill.model || "");

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Skill name (e.g. dependency-analyzer)"
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
        disabled={!isNew}
      />
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description"
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Skill prompt — injected into the agent's context before the issue description"
        rows={6}
        className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
      />
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model override (optional, e.g. haiku)"
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSave({ name, description, prompt, model })}
          disabled={!name || !prompt}
          className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {isNew ? "Create" : "Save"}
        </button>
        <button onClick={onCancel} className="text-xs px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({ onClose, activeProjectId }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("agent");

  // Project-specific settings
  const [projectSettings, setProjectSettings] = useState<{ setupScript: string; setupBlocking: boolean; teardownScript: string }>({
    setupScript: "",
    setupBlocking: true,
    teardownScript: "",
  });
  const [generatingScript, setGeneratingScript] = useState(false);

  // Skills state
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean }[]>([]);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState<{ name: string; description: string; prompt: string; model: string } | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [data, profileData, skillsData] = await Promise.all([
          apiFetch<Record<string, string>>("/api/preferences/settings"),
          apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles"),
          apiFetch<{ id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean }[]>("/api/agent-skills"),
        ]);
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setProfiles(profileData.profiles);
        setSkills(skillsData);

        // Load project-specific settings
        if (activeProjectId) {
          try {
            const projects = await apiFetch<{ setupScript: string | null; setupBlocking: boolean }[]>(("/api/projects"));
            const project = projects.find((p: any) => p.id === activeProjectId);
            if (project) {
              setProjectSettings({
                setupScript: project.setupScript || "",
                setupBlocking: project.setupBlocking !== false,
                teardownScript: (project as any).teardownScript || "",
              });
            }
          } catch {
            // Use defaults for project settings
          }
        }
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
      const promises: Promise<unknown>[] = [
        apiFetch("/api/preferences/settings", {
          method: "PUT",
          body: JSON.stringify(settings),
        }),
      ];
      if (activeProjectId) {
        promises.push(
          apiFetch(`/api/projects/${activeProjectId}`, {
            method: "PATCH",
            body: JSON.stringify({
              setupScript: projectSettings.setupScript || null,
              setupBlocking: projectSettings.setupBlocking,
              teardownScript: projectSettings.teardownScript || null,
            }),
          }),
        );
      }
      await Promise.all(promises);
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
                      checked={settings.review_auto_fix !== "false"}
                      onChange={setBool("review_auto_fix")}
                      label="Auto-fix issues found in review"
                      hint="When the review agent finds CRITICAL or MAJOR issues, it edits the code and commits fixes directly. Requires 'Skip permission prompts' to be enabled so the agent can write files. When disabled, the agent reports issues but makes no changes."
                      disabled={!autoReviewOn}
                    />
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

              {/* Skills tab */}
              {tab === "skills" && (
                <div className="space-y-3">
                  <p className="text-xs text-gray-500">
                    Agent skills are prompt templates injected into the agent's context when launching a workspace. They teach the agent how to interact with the board and perform specific tasks. Skills can be global or scoped to a specific project.
                  </p>
                  {skills.map((skill) => (
                    <div key={skill.id} className="border border-gray-200 rounded-md p-3">
                      {editingSkill === skill.id ? (
                        <EditSkillForm
                          skill={skill}
                          onSave={async (updates) => {
                            await apiFetch(`/api/agent-skills/${skill.id}`, {
                              method: "PUT",
                              body: JSON.stringify(updates),
                            });
                            setSkills((s) => s.map((sk) => sk.id === skill.id ? { ...sk, ...updates } : sk));
                            setEditingSkill(null);
                          }}
                          onCancel={() => setEditingSkill(null)}
                        />
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{skill.name}</span>
                              {skill.isBuiltin && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">builtin</span>
                              )}
                              {skill.projectId ? (
                                <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">project</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded">global</span>
                              )}
                              {skill.model && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded">{skill.model}</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{skill.description}</p>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => setEditingSkill(skill.id)}
                              className="text-xs text-gray-400 hover:text-blue-600 px-1"
                            >
                              Edit
                            </button>
                            {!skill.isBuiltin && (
                              <button
                                onClick={async () => {
                                  await apiFetch(`/api/agent-skills/${skill.id}`, { method: "DELETE" });
                                  setSkills((s) => s.filter((sk) => sk.id !== skill.id));
                                }}
                                className="text-xs text-gray-400 hover:text-red-600 px-1"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {newSkill ? (
                    <div className="border border-gray-200 rounded-md p-3">
                      <EditSkillForm
                        skill={{ name: newSkill.name, description: newSkill.description, prompt: newSkill.prompt, model: newSkill.model || null, projectId: null }}
                        isNew
                        onSave={async (data) => {
                          const created = await apiFetch<{ id: string }>("/api/agent-skills", {
                            method: "POST",
                            body: JSON.stringify(data),
                          });
                          setSkills((s) => [...s, { ...data, id: created.id, isBuiltin: false, projectId: null }]);
                          setNewSkill(null);
                        }}
                        onCancel={() => setNewSkill(null)}
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewSkill({ name: "", description: "", prompt: "", model: "" })}
                      className="text-sm text-blue-600 hover:text-blue-700"
                    >
                      + Add Skill
                    </button>
                  )}
                </div>
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

              {/* Project tab */}
              {tab === "project" && (
                <>
                  {!activeProjectId ? (
                    <p className="text-sm text-gray-500">No active project selected.</p>
                  ) : (
                    <>
                      <Field label="Setup Script" hint="Shell command(s) to run in each new workspace after the git worktree is created. Use && to chain multiple commands. Leave empty to skip setup.">
                        <textarea
                          value={projectSettings.setupScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, setupScript: e.target.value }))}
                          placeholder="pnpm install"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
                      </Field>
                      <button
                        onClick={async () => {
                          if (!activeProjectId || generatingScript) return;
                          setGeneratingScript(true);
                          try {
                            const result = await apiFetch<{ setupScript: string }>(
                              "/api/projects/generate-setup-script",
                              {
                                method: "POST",
                                body: JSON.stringify({ projectId: activeProjectId }),
                              },
                            );
                            if (result.setupScript) {
                              setProjectSettings(s => ({ ...s, setupScript: result.setupScript }));
                            }
                          } catch {
                            showToast("Failed to generate setup script", "error");
                          } finally {
                            setGeneratingScript(false);
                          }
                        }}
                        disabled={generatingScript || !activeProjectId}
                        className="text-xs text-purple-600 px-2 py-1.5 hover:text-purple-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        {generatingScript ? (
                          <>
                            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                            </svg>
                            Generating...
                          </>
                        ) : (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
                            </svg>
                            Generate with AI
                          </>
                        )}
                      </button>
                      <Toggle
                        checked={projectSettings.setupBlocking}
                        onChange={(v) => setProjectSettings(s => ({ ...s, setupBlocking: v }))}
                        label="Run setup before agent"
                        hint="When enabled, the setup script must complete before the agent starts. When disabled, both run in parallel (faster but the agent may start before dependencies are installed)."
                      />
                      <Field label="Teardown Script" hint="Shell command(s) to run in the worktree before it is removed on merge (e.g. stop services, rm -rf node_modules). Leave empty to skip.">
                        <textarea
                          value={projectSettings.teardownScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, teardownScript: e.target.value }))}
                          placeholder="pkill -f dev-server || true"
                          rows={3}
                          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
                        />
                      </Field>
                    </>
                  )}
                </>
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
