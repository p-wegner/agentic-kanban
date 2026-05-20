import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { MCP_TOOL_DEFINITIONS, MCP_TOOL_CATEGORIES } from "@agentic-kanban/shared/lib";

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
  disabled_mcp_tools?: string;
  auto_start_followup?: string;
  require_manual_approval?: string;
  dynamic_column_scaling?: string;
  persistent_agent?: string;
  learning_step_after_agent?: string;
  learning_step_after_review?: string;
  learning_step_before_merge?: string;
  auto_monitor?: string;
  auto_monitor_interval?: string;
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
  nudge_auto_start?: string;
  nudge_wip_limit?: string;
>>>>>>> badbfcc (feat: add nudge auto-start setting to monitor for unblocked Todo items)
  projects_base_path?: string;
=======
  projects_base_dir?: string;
>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder?: string;
>>>>>>> 9a513e9 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir?: string;
>>>>>>> bda3153 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder?: string;
>>>>>>> 6f16985 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir?: string;
>>>>>>> d4d0a21 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_path?: string;
>>>>>>> 9196ac9 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
  projects_base_dir?: string;
>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder?: string;
>>>>>>> 6707bf7 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir?: string;
>>>>>>> 32bf0fc (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder?: string;
>>>>>>> da0cb52 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir?: string;
>>>>>>> 827c80a (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_path?: string;
>>>>>>> d7a5078 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
  projects_base_dir?: string;
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder?: string;
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir?: string;
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder?: string;
>>>>>>> 4f19939 (WIP: uncommitted changes in SettingsPanel and register-project test)
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
  disabled_mcp_tools: "",
  auto_start_followup: "false",
  require_manual_approval: "false",
  dynamic_column_scaling: "false",
  persistent_agent: "false",
  learning_step_after_agent: "false",
  learning_step_after_review: "false",
  learning_step_before_merge: "false",
  auto_monitor: "false",
  auto_monitor_interval: "4",
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
  nudge_auto_start: "false",
  nudge_wip_limit: "5",
>>>>>>> badbfcc (feat: add nudge auto-start setting to monitor for unblocked Todo items)
  projects_base_path: "",
=======
  projects_base_dir: "",
>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder: "",
>>>>>>> 9a513e9 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir: "",
>>>>>>> bda3153 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder: "",
>>>>>>> 6f16985 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir: "",
>>>>>>> d4d0a21 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_path: "",
>>>>>>> 9196ac9 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
  projects_base_dir: "",
>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder: "",
>>>>>>> 6707bf7 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir: "",
>>>>>>> 32bf0fc (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder: "",
>>>>>>> da0cb52 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir: "",
>>>>>>> 827c80a (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_path: "",
>>>>>>> d7a5078 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
  projects_base_dir: "",
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
  projects_base_folder: "",
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
  projects_base_dir: "",
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
  projects_base_folder: "",
>>>>>>> 4f19939 (WIP: uncommitted changes in SettingsPanel and register-project test)
};

type Tab = "agent" | "workflow" | "skills" | "mcp" | "ui" | "project" | "tags" | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflow", label: "Workflow" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Tools" },
  { id: "ui", label: "UI" },
  { id: "project", label: "Project" },
  { id: "tags", label: "Tags" },
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

function CollapsibleSection({ title, configured, defaultOpen, children }: {
  title: string;
  configured?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-gray-200 rounded-md">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-md"
      >
        <span className="flex items-center gap-2">
          {title}
          {configured && !open && (
            <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded">configured</span>
          )}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 space-y-2 border-t border-gray-100">
          {children}
        </div>
      )}
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

function ToolToggle({ name, description, disabled, onToggle }: {
  name: string;
  description: string;
  disabled: boolean;
  onToggle: (disabled: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <label className="flex items-center gap-2 cursor-pointer select-none pt-0.5">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(e) => onToggle(!e.target.checked)}
          className="rounded border-gray-300"
        />
        <span className="text-sm font-mono text-gray-800">{name}</span>
      </label>
      <p className="text-xs text-gray-500 flex-1">{description}</p>
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
  const [projectSettings, setProjectSettings] = useState<{ setupScript: string; setupBlocking: boolean; setupEnabled: boolean; teardownScript: string }>({
    setupScript: "",
    setupBlocking: true,
    setupEnabled: true,
    teardownScript: "",
  });
  const [generatingScript, setGeneratingScript] = useState(false);
  const [generatingTeardown, setGeneratingTeardown] = useState(false);

  // Skills state
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean }[]>([]);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState<{ name: string; description: string; prompt: string; model: string } | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Record<string, boolean>>({});
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);
=======
>>>>>>> 9e48722 (feat: install kanban skills to project .claude/skills/ from Settings UI)

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);
=======
>>>>>>> e23b7a0 (feat: install kanban skills to project .claude/skills/ from Settings UI)

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);
=======
>>>>>>> ad9bf6a (feat: install kanban skills to project .claude/skills/ from Settings UI)

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);
=======
>>>>>>> 74c8daf (feat: install kanban skills to project .claude/skills/ from Settings UI)
=======
>>>>>>> f6b75e2 (feat: install kanban skills to project .claude/skills/ from Settings UI)

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);
=======
>>>>>>> 9e48722 (feat: install kanban skills to project .claude/skills/ from Settings UI)

  // Tags state
  const [tagsList, setTagsList] = useState<{ id: string; name: string; color: string | null }[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);

  const disabledTools = new Set((settings.disabled_mcp_tools || "").split(",").filter(Boolean));
  function isToolDisabled(name: string) {
    return disabledTools.has(name);
  }
  function toggleTool(name: string, disabled: boolean) {
    const next = new Set(disabledTools);
    if (disabled) next.add(name);
    else next.delete(name);
    setSettings((s) => ({ ...s, disabled_mcp_tools: [...next].join(",") }));
  }

  useEffect(() => {
    async function load() {
      try {
        const [data, profileData, skillsData, tagsData] = await Promise.all([
          apiFetch<Record<string, string>>("/api/preferences/settings"),
          apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles"),
          apiFetch<{ id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean }[]>("/api/agent-skills"),
          apiFetch<{ id: string; name: string; color: string | null }[]>("/api/tags"),
        ]);
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setProfiles(profileData.profiles);
        setSkills(skillsData);
        setTagsList(tagsData);
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));
=======
>>>>>>> 0ab88a1 (feat: add Tags management tab to Settings panel)

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));
=======
>>>>>>> 1e9a6e9 (feat: add Tags management tab to Settings panel)

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));
=======
>>>>>>> bd81ec1 (feat: add Tags management tab to Settings panel)

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));
=======
>>>>>>> 0234410 (feat: add Tags management tab to Settings panel)
=======
>>>>>>> 3d619ec (feat: add Tags management tab to Settings panel)

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));
=======
>>>>>>> 0ab88a1 (feat: add Tags management tab to Settings panel)

        // Check install status for each skill
        const statusEntries = await Promise.all(
          skillsData.map(async (skill) => {
            try {
              const s = await apiFetch<{ installed: boolean }>(`/api/agent-skills/${skill.id}/install-status`);
              return [skill.id, s.installed] as const;
            } catch {
              return [skill.id, false] as const;
            }
          })
        );
        setInstalledSkills(Object.fromEntries(statusEntries));

        // Load project-specific settings
        if (activeProjectId) {
          try {
            const projects = await apiFetch<{ setupScript: string | null; setupBlocking: boolean }[]>(("/api/projects"));
            const project = projects.find((p: any) => p.id === activeProjectId);
            if (project) {
              setProjectSettings({
                setupScript: project.setupScript || "",
                setupBlocking: project.setupBlocking !== false,
                setupEnabled: (project as any).setupEnabled !== false,
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
              setupEnabled: projectSettings.setupEnabled,
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
      <div className="relative w-full max-w-3xl bg-white rounded-xl shadow-2xl flex flex-col h-[80vh] max-h-[92vh] animate-slide-in-right">
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
                  {/* Process pipeline visualization */}
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-2">
                    <div className="text-xs font-medium text-gray-600 mb-2">Process pipeline</div>
                    <div className="flex items-center gap-1 flex-wrap">
                      {[
                        { label: "Agent runs", always: true },
                        { label: "Manual approval", key: "require_manual_approval", enabled: settings.require_manual_approval === "true" },
                        { label: "Learn (after agent)", key: "learning_step_after_agent", enabled: settings.learning_step_after_agent === "true" },
                        { label: "AI Review", key: "auto_review", enabled: settings.auto_review !== "false" },
                        { label: "Auto-fix", key: "review_auto_fix", enabled: settings.auto_review !== "false" && settings.review_auto_fix !== "false", indent: true },
                        { label: "Learn (after review)", key: "learning_step_after_review", enabled: settings.learning_step_after_review === "true" },
                        { label: "Auto-merge", key: "auto_merge", enabled: settings.auto_review !== "false" && settings.auto_merge !== "false", indent: true },
                        { label: "Learn (before merge)", key: "learning_step_before_merge", enabled: settings.learning_step_before_merge === "true" },
                        { label: "Merge", always: true },
                      ].filter(s => s.always || s.enabled).map((step, i, arr) => (
                        <div key={step.label} className="flex items-center gap-1">
                          {i > 0 && <span className="text-gray-400 text-xs">→</span>}
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${step.always ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                            {step.label}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="text-xs text-gray-400 mt-1.5">Green steps are optional — toggle them below to add/remove from pipeline.</div>
                  </div>
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
                  <Toggle
                    checked={settings.auto_start_followup === "true"}
                    onChange={setBool("auto_start_followup")}
                    label="Auto-start follow-up tasks after merge"
                    hint="When a workspace is merged and the issue has outgoing 'depends_on' or 'child_of' dependencies, automatically create workspaces for unblocked follow-up issues."
                  />
                  <Toggle
                    checked={settings.require_manual_approval === "true"}
                    onChange={setBool("require_manual_approval")}
                    label="Require manual approval before review"
                    hint="When enabled, issues must be manually approved before the AI review step is triggered. Useful for gating expensive review sessions on deliberate human sign-off."
                  />
                  <Toggle
                    checked={settings.learning_step_after_agent === "true"}
                    onChange={setBool("learning_step_after_agent")}
                    label="Learning step after agent (parallel)"
                    hint="When an agent session completes with committed changes, runs a learning session in parallel with code review. Extracts insights from session transcripts and updates docs and hooks without blocking the review."
                  />
                  <Toggle
                    checked={settings.learning_step_after_review === "true"}
                    onChange={setBool("learning_step_after_review")}
                    label="Learning step after review (parallel)"
                    hint="When a review session completes, runs a learning session in parallel with the auto-merge step. Extracts insights without delaying the merge."
                  />
                  <Toggle
                    checked={settings.learning_step_before_merge === "true"}
                    onChange={setBool("learning_step_before_merge")}
                    label="Learning step before merge (blocking)"
                    hint="When enabled, runs an agent session before merging that reads the worktree's session transcripts and updates docs and Claude hooks with extracted insights. Blocks merge until complete (up to 3 minutes)."
                  />

                  <div className="pt-2 border-t border-gray-100">
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Board Monitoring</div>
                    <Toggle
                      checked={settings.auto_monitor === "true"}
                      onChange={setBool("auto_monitor")}
                      label="Auto-monitor board for stuck agents"
                      hint="Periodically checks all active workspaces. Relaunches idle workspaces, triggers merges for completed reviews, and nudges agents waiting for input."
                    />
                    {settings.auto_monitor === "true" && (
                      <div className="pl-5 mt-2 flex items-center gap-2">
                        <label className="text-xs text-gray-500 whitespace-nowrap">Check every</label>
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={settings.auto_monitor_interval ?? "4"}
                          onChange={(e) => setSettings(s => ({ ...s, auto_monitor_interval: e.target.value }))}
                          className="w-16 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-500">minutes</span>
                      </div>
                    )}
                    {settings.auto_monitor === "true" && (
                      <div className="mt-3">
                        <Toggle
                          checked={settings.nudge_auto_start === "true"}
                          onChange={setBool("nudge_auto_start")}
                          label="Auto-start unblocked Todo items"
                          hint="When enabled, the monitor will also create workspaces for Todo issues whose dependencies are resolved, up to the In Progress WIP limit."
                        />
                        {settings.nudge_auto_start === "true" && (
                          <div className="pl-5 mt-2 flex items-center gap-2">
                            <label className="text-xs text-gray-500 whitespace-nowrap">In Progress WIP limit</label>
                            <input
                              type="number"
                              min={1}
                              max={20}
                              value={settings.nudge_wip_limit ?? "5"}
                              onChange={(e) => setSettings(s => ({ ...s, nudge_wip_limit: e.target.value }))}
                              className="w-16 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-500">issues max</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
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
                            <button
                              title={installedSkills[skill.id] ? "Re-install to project (.claude/skills/)" : "Install to project (.claude/skills/)"}
                              disabled={installingSkill === skill.id}
                              onClick={async () => {
                                setInstallingSkill(skill.id);
                                try {
                                  await apiFetch(`/api/agent-skills/${skill.id}/install`, { method: "POST" });
                                  setInstalledSkills((s) => ({ ...s, [skill.id]: true }));
                                  showToast(`Installed "${skill.name}" to .claude/skills/`, "success");
                                } catch {
                                  showToast("Install failed", "error");
                                } finally {
                                  setInstallingSkill(null);
                                }
                              }}
                              className={`text-xs px-1 ${installedSkills[skill.id] ? "text-green-600 hover:text-green-700" : "text-gray-400 hover:text-green-600"}`}
                            >
                              {installingSkill === skill.id ? "…" : installedSkills[skill.id] ? "✓ installed" : "Install"}
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

              {/* MCP Tools tab */}
              {tab === "mcp" && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Enable or disable individual MCP tools. Disabled tools won't be registered with the MCP server and won't be available to connected AI agents. Requires MCP server restart to take effect.
                  </p>
                  {MCP_TOOL_CATEGORIES.map((cat) => {
                    const catTools = MCP_TOOL_DEFINITIONS.filter((t) => t.category === cat.id);
                    return (
                      <div key={cat.id}>
                        <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{cat.label}</h4>
                        <div className="space-y-1.5">
                          {catTools.map((tool) => (
                            <ToolToggle
                              key={tool.name}
                              name={tool.name}
                              description={tool.description}
                              disabled={isToolDisabled(tool.name)}
                              onToggle={(disabled) => toggleTool(tool.name, disabled)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* UI tab */}
              {tab === "ui" && (
                <>
                <Field label="Output Parsing" hint={`When enabled, the terminal view parses structured agent output and displays it with syntax highlighting. "Minimal" shows a compact activity timeline.`}>
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
                <div className="space-y-3 mt-4">
                  <Toggle
                    checked={settings.dynamic_column_scaling === "true"}
                    onChange={setBool("dynamic_column_scaling")}
                    label="Dynamic column scaling"
                    hint="Columns grow proportionally to their issue count, giving more space to busy columns."
                  />
                  <Toggle
                    checked={settings.persistent_agent === "true"}
                    onChange={setBool("persistent_agent")}
                    label="Persistent agent (warm pool)"
                    hint="Keep a warm agent process alive between sessions to reduce startup latency. Experimental."
                  />
                </div>
                </>
              )}

              {/* Project tab */}
              {tab === "project" && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Projects base directory
                    </label>
                    <input
                      type="text"
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
                      value={settings.projects_base_path ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_path: e.target.value }))}
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> 73b13d2 (feat: implement create project flow (WIP - UI + backend route))
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> 9a513e9 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> bda3153 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> 6f16985 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> d4d0a21 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
                      value={settings.projects_base_path ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_path: e.target.value }))}
>>>>>>> 9196ac9 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> e6a6ccb (feat: implement create project flow (WIP - UI + backend route))
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> 6707bf7 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> 32bf0fc (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> da0cb52 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> 827c80a (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
                      value={settings.projects_base_path ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_path: e.target.value }))}
>>>>>>> d7a5078 (fix: align projects_base_dir -> projects_base_path across cli.ts and SettingsPanel.tsx)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
                      value={settings.projects_base_dir ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_dir: e.target.value }))}
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
                      value={settings.projects_base_folder ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_folder: e.target.value }))}
>>>>>>> 4f19939 (WIP: uncommitted changes in SettingsPanel and register-project test)
                      placeholder="C:/projects"
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Default parent folder for new projects created via "Create new project". New projects are created as subdirectories here.
                    </p>
                  </div>
                  {!activeProjectId ? (
                    <p className="text-sm text-gray-500">No active project selected.</p>
                  ) : (
                    <div className="space-y-3">
                      <CollapsibleSection
                        title="Setup Script"
                        configured={!!projectSettings.setupScript}
                        defaultOpen={!!projectSettings.setupScript}
                      >
                        <p className="text-xs text-gray-500">Shell command(s) to run in each new workspace after the git worktree is created. Use && to chain multiple commands.</p>
                        <textarea
                          value={projectSettings.setupScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, setupScript: e.target.value }))}
                          placeholder="pnpm install"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
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
                      </CollapsibleSection>
                      <Toggle
                        checked={projectSettings.setupEnabled}
                        onChange={(v) => setProjectSettings(s => ({ ...s, setupEnabled: v }))}
                        label="Enable setup/teardown scripts"
                        hint="When disabled, setup and teardown scripts won't run even if configured. Useful for tasks that don't need dependency installation (e.g. doc-only changes)."
                      />
                      <CollapsibleSection
                        title="Teardown Script"
                        configured={!!projectSettings.teardownScript}
                        defaultOpen={!!projectSettings.teardownScript}
                      >
                        <p className="text-xs text-gray-500">Shell command(s) to run in the worktree before it is removed on merge (e.g. stop services, rm -rf node_modules).</p>
                        <textarea
                          value={projectSettings.teardownScript}
                          onChange={(e) => setProjectSettings(s => ({ ...s, teardownScript: e.target.value }))}
                          placeholder="pkill -f dev-server || true"
                          rows={3}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                        />
                        <button
                          onClick={async () => {
                            if (!activeProjectId || generatingTeardown) return;
                            setGeneratingTeardown(true);
                            try {
                              const result = await apiFetch<{ teardownScript: string }>(
                                "/api/projects/generate-teardown-script",
                                {
                                  method: "POST",
                                  body: JSON.stringify({ projectId: activeProjectId }),
                                },
                              );
                              if (result.teardownScript) {
                                setProjectSettings(s => ({ ...s, teardownScript: result.teardownScript }));
                              }
                            } catch {
                              showToast("Failed to generate teardown script", "error");
                            } finally {
                              setGeneratingTeardown(false);
                            }
                          }}
                          disabled={generatingTeardown || !activeProjectId}
                          className="text-xs text-purple-600 px-2 py-1.5 hover:text-purple-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                        >
                          {generatingTeardown ? (
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
                      </CollapsibleSection>
                    </div>
                  )}
                </>
              )}

              {/* Tags tab */}
              {tab === "tags" && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Manage tags used to categorize issues. You can rename, delete, or merge tags together.
                    Merging moves all issues from the selected tags onto the target tag, then removes the merged tags.
                  </p>

                  {/* Tag list */}
                  <div className="space-y-2">
                    {tagsList.map((tag) => (
                      <div key={tag.id} className="flex items-center gap-2 border border-gray-200 rounded-md px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedTagIds.has(tag.id)}
                          onChange={(e) => {
                            const next = new Set(selectedTagIds);
                            if (e.target.checked) next.add(tag.id);
                            else next.delete(tag.id);
                            setSelectedTagIds(next);
                          }}
                          className="rounded border-gray-300 shrink-0"
                        />
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: tag.color ?? "#6B7280" }}
                        />
                        {editingTag === tag.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <input
                              type="text"
                              value={editTagName}
                              onChange={(e) => setEditTagName(e.target.value)}
                              className="flex-1 text-sm border border-gray-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              autoFocus
                            />
                            <input
                              type="color"
                              value={editTagColor || "#6B7280"}
                              onChange={(e) => setEditTagColor(e.target.value)}
                              className="w-7 h-7 rounded border border-gray-300 cursor-pointer p-0.5"
                            />
                            <button
                              onClick={async () => {
                                if (!editTagName.trim()) return;
                                await apiFetch(`/api/tags/${tag.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ name: editTagName.trim(), color: editTagColor || null }),
                                });
                                setTagsList((t) => t.map((tg) => tg.id === tag.id ? { ...tg, name: editTagName.trim(), color: editTagColor || null } : tg));
                                setEditingTag(null);
                                showToast("Tag updated", "success");
                              }}
                              className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingTag(null)}
                              className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="flex-1 text-sm text-gray-800">{tag.name}</span>
                            <button
                              onClick={() => { setEditingTag(tag.id); setEditTagName(tag.name); setEditTagColor(tag.color ?? "#6B7280"); }}
                              className="text-xs text-gray-400 hover:text-blue-600"
                            >
                              Rename
                            </button>
                            <button
                              onClick={async () => {
                                if (!confirm(`Delete tag "${tag.name}"? This will remove it from all issues.`)) return;
                                await apiFetch(`/api/tags/${tag.id}`, { method: "DELETE" });
                                setTagsList((t) => t.filter((tg) => tg.id !== tag.id));
                                setSelectedTagIds((s) => { const n = new Set(s); n.delete(tag.id); return n; });
                                showToast("Tag deleted", "success");
                              }}
                              className="text-xs text-gray-400 hover:text-red-600"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Merge section */}
                  {selectedTagIds.size >= 2 && (
                    <div className="border border-amber-200 bg-amber-50 rounded-md p-3 space-y-2">
                      <p className="text-xs font-medium text-amber-800">
                        Merge {selectedTagIds.size} selected tags into one
                      </p>
                      <p className="text-xs text-amber-700">
                        All issues from the merged tags will be re-tagged with the target tag. The other tags will be deleted.
                      </p>
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-amber-800 whitespace-nowrap">Merge into:</label>
                        <select
                          value={mergeTargetId}
                          onChange={(e) => setMergeTargetId(e.target.value)}
                          className="flex-1 text-sm border border-amber-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-500 bg-white"
                        >
                          <option value="">Select target tag…</option>
                          {tagsList.filter((t) => selectedTagIds.has(t.id)).map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        <button
                          disabled={!mergeTargetId || mergingTags}
                          onClick={async () => {
                            if (!mergeTargetId) return;
                            const sourceIds = [...selectedTagIds].filter((id) => id !== mergeTargetId);
                            setMergingTags(true);
                            try {
                              await apiFetch("/api/tags/merge", {
                                method: "POST",
                                body: JSON.stringify({ targetId: mergeTargetId, sourceIds }),
                              });
                              setTagsList((t) => t.filter((tg) => tg.id === mergeTargetId || !selectedTagIds.has(tg.id)));
                              setSelectedTagIds(new Set());
                              setMergeTargetId("");
                              showToast("Tags merged", "success");
                            } catch {
                              showToast("Merge failed", "error");
                            } finally {
                              setMergingTags(false);
                            }
                          }}
                          className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                        >
                          {mergingTags ? "Merging…" : "Merge"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* New tag form */}
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <p className="text-xs font-medium text-gray-600">Add new tag</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={newTagColor}
                        onChange={(e) => setNewTagColor(e.target.value)}
                        className="w-7 h-7 rounded border border-gray-300 cursor-pointer p-0.5 shrink-0"
                      />
                      <input
                        type="text"
                        value={newTagName}
                        onChange={(e) => setNewTagName(e.target.value)}
                        placeholder="Tag name"
                        className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newTagName.trim()) e.currentTarget.form?.requestSubmit();
                        }}
                      />
                      <button
                        disabled={!newTagName.trim()}
                        onClick={async () => {
                          if (!newTagName.trim()) return;
                          const created = await apiFetch<{ id: string; name: string; color: string | null }>("/api/tags", {
                            method: "POST",
                            body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
                          });
                          setTagsList((t) => [...t, created]);
                          setNewTagName("");
                          setNewTagColor("#6B7280");
                          showToast("Tag created", "success");
                        }}
                        className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
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
