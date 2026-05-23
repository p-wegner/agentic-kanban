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
  nudge_auto_start?: string;
  nudge_wip_limit?: string;
  projects_base_path?: string;
}

const DEFAULT_SETTINGS: Settings = {
  agent_command: "",
  agent_args: "",
  output_parser: "true",
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
  nudge_auto_start: "false",
  projects_base_path: "",
};

type Tab = "agent" | "workflow" | "skills" | "mcp" | "ui" | "project" | "tags" | "advanced" | "schedule";

const TABS: { id: Tab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflow", label: "Workflow" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP Tools" },
  { id: "ui", label: "UI" },
  { id: "project", label: "Project" },
  { id: "tags", label: "Tags" },
  { id: "schedule", label: "Schedule" },
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
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ name: string; description: string; prompt: string } | null>(null);

  async function handleEnhance() {
    if (!name.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ name, description, prompt });
      const result = await apiFetch<{ name: string; description: string; prompt: string }>("/api/agent-skills/enhance", {
        method: "POST",
        body: JSON.stringify({ name, description, prompt }),
      });
      setName(result.name);
      setDescription(result.description);
      setPrompt(result.prompt);
    } catch (err) {
      setPreEnhanceSnapshot(null);
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setEnhancing(false);
    }
  }

  function handleUndoEnhance() {
    if (!preEnhanceSnapshot) return;
    setName(preEnhanceSnapshot.name);
    setDescription(preEnhanceSnapshot.description);
    setPrompt(preEnhanceSnapshot.prompt);
    setPreEnhanceSnapshot(null);
  }

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
      <div className="flex gap-2 flex-wrap">
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
        <button
          onClick={handleEnhance}
          disabled={!name.trim() || enhancing}
          className="text-xs px-3 py-1.5 text-purple-700 border border-purple-300 rounded hover:bg-purple-50 disabled:opacity-50 flex items-center gap-1"
        >
          {enhancing ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
              Enhancing…
            </>
          ) : (
            "Enhance with AI"
          )}
        </button>
        {preEnhanceSnapshot && (
          <button
            onClick={handleUndoEnhance}
            className="text-xs px-3 py-1.5 text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
          >
            Undo enhance
          </button>
        )}
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

type ScheduledRun = {
  id: string; name: string; description: string | null; projectId: string;
  prompt: string | null; skillId: string | null; intervalMinutes: number;
  cronExpression: string | null;
  enabled: boolean; lastRunAt: string | null; lastRunStatus: string | null;
};

function validateCronExpression(expr: string): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: "Must have exactly 5 fields: minute hour day month weekday" };
  }
  const ranges = [{ name: "minute", min: 0, max: 59 }, { name: "hour", min: 0, max: 23 }, { name: "day", min: 1, max: 31 }, { name: "month", min: 1, max: 12 }, { name: "weekday", min: 0, max: 6 }];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    try {
      const vals: number[] = [];
      for (const part of field.split(",")) {
        if (part === "*") { for (let v = ranges[i].min; v <= ranges[i].max; v++) vals.push(v); }
        else if (part.startsWith("*/")) { const s = parseInt(part.slice(2), 10); for (let v = ranges[i].min; v <= ranges[i].max; v += s) vals.push(v); }
        else if (part.includes("-")) { const [lo, hi] = part.split("-").map(Number); for (let v = lo; v <= hi; v++) vals.push(v); }
        else { vals.push(parseInt(part, 10)); }
      }
      const bad = vals.filter(v => isNaN(v) || v < ranges[i].min || v > ranges[i].max);
      if (bad.length) return { valid: false, error: `${ranges[i].name} value ${bad[0]} out of range` };
    } catch {
      return { valid: false, error: `Invalid ${ranges[i].name} field: ${field}` };
    }
  }
  return { valid: true };
}

function describeCronExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mF, hF, domF, monF, dowF] = parts;
  const pad = (n: string) => n.padStart(2, "0");
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (mF === "*" && hF === "*" && domF === "*" && monF === "*" && dowF === "*") return "Every minute";
  if (mF.startsWith("*/") && hF === "*" && domF === "*" && monF === "*" && dowF === "*") return `Every ${mF.slice(2)} minutes`;
  if (hF === "*" && domF === "*" && monF === "*" && dowF === "*") return `Every hour at minute ${mF}`;
  const simpleTime = /^\d+$/.test(mF) && /^\d+$/.test(hF);
  const timeStr = simpleTime ? `${pad(hF)}:${pad(mF)}` : null;
  if (domF === "*" && monF === "*" && simpleTime) {
    if (dowF === "*") return `Daily at ${timeStr}`;
    if (dowF === "1-5") return `Weekdays at ${timeStr}`;
    if (dowF === "6,0" || dowF === "0,6") return `Weekends at ${timeStr}`;
    if (/^\d$/.test(dowF)) return `Every ${DOW[parseInt(dowF)]} at ${timeStr}`;
    if (/^\d(,\d)+$/.test(dowF)) return `${dowF.split(",").map(d => DOW[parseInt(d)]).join(", ")} at ${timeStr}`;
  }
  if (domF !== "*" && monF === "*" && dowF === "*" && simpleTime && /^\d+$/.test(domF)) return `Monthly on day ${domF} at ${timeStr}`;
  return expr;
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

  // Scheduled runs state
  const [scheduledRunsList, setScheduledRunsList] = useState<ScheduledRun[]>([]);
  const [newRunName, setNewRunName] = useState("");
  const [newRunPrompt, setNewRunPrompt] = useState("");
  const [newRunInterval, setNewRunInterval] = useState(60);
  const [newRunCron, setNewRunCron] = useState("");
  const [newRunMode, setNewRunMode] = useState<"interval" | "cron">("interval");
  const [savingRun, setSavingRun] = useState(false);
  const [triggeringRun, setTriggeringRun] = useState<string | null>(null);
  const [editingRun, setEditingRun] = useState<string | null>(null);
  const [editRunName, setEditRunName] = useState("");
  const [editRunPrompt, setEditRunPrompt] = useState("");
  const [editRunInterval, setEditRunInterval] = useState(60);
  const [editRunCron, setEditRunCron] = useState("");
  const [editRunMode, setEditRunMode] = useState<"interval" | "cron">("interval");
  const [savingEditRun, setSavingEditRun] = useState(false);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState<{
    enabled: boolean;
    intervalMin: number;
    active: boolean;
    lastRun: string | null;
    nextRunAt: string | null;
    recentActions: string[];
  } | null>(null);

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

        // Load scheduled runs
        if (activeProjectId) {
          try {
            const runs = await apiFetch<ScheduledRun[]>(`/api/scheduled-runs?projectId=${activeProjectId}`);
            setScheduledRunsList(runs);
          } catch { /* non-fatal */ }
        }

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
    if (tab === "workflow") fetchMonitorStatus();
  }, [tab]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function fetchMonitorStatus() {
    try {
      const s = await apiFetch<NonNullable<typeof monitorStatus>>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } catch { /* non-fatal */ }
  }

  async function handleMonitorRunNow() {
    setMonitorRunning(true);
    try {
      await apiFetch("/api/internal/monitor-run", { method: "POST" });
      showToast("Monitor cycle triggered", "success");
      setTimeout(fetchMonitorStatus, 1500);
    } catch {
      showToast("Failed to trigger monitor", "error");
    } finally {
      setMonitorRunning(false);
    }
  }

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-5xl bg-white rounded-xl shadow-2xl flex flex-col h-[90vh] max-h-[96vh] animate-slide-in-right">
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

                  <div className="pt-3 border-t border-gray-200">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Board Monitor</div>
                        {monitorStatus && (
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${monitorStatus.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${monitorStatus.active ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
                            {monitorStatus.active ? "Active" : "Idle"}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={handleMonitorRunNow}
                        disabled={monitorRunning}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        title="Run a monitor cycle now and restart the interval timer"
                      >
                        {monitorRunning ? (
                          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                        ) : (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
                        )}
                        {monitorRunning ? "Running…" : "Run now"}
                      </button>
                    </div>
                    <div className="flex items-center gap-4">
                      <Toggle
                        checked={settings.auto_monitor === "true"}
                        onChange={setBool("auto_monitor")}
                        label="Auto-monitor"
                        hint="Periodically checks workspaces and relaunches idle agents, triggers merges, and auto-starts unblocked issues."
                      />
                    </div>
                    {settings.auto_monitor === "true" && (
                      <div className="mt-2 pl-5 flex items-center gap-2">
                        <label className="text-xs text-gray-600">Interval</label>
                        <input
                          type="number"
                          min="1"
                          max="60"
                          value={settings.auto_monitor_interval || "4"}
                          onChange={(e) => set("auto_monitor_interval")(e.target.value)}
                          className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-500">min</span>
                      </div>
                    )}
                    {monitorStatus && (
                      <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                          <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Last cycle</span>
                          <div className="flex items-center gap-3 text-[11px] text-gray-500">
                            {monitorStatus.lastRun && (
                              <span title={new Date(monitorStatus.lastRun).toLocaleString()}>{new Date(monitorStatus.lastRun).toLocaleTimeString()}</span>
                            )}
                            {monitorStatus.nextRunAt && (
                              <span className="text-blue-500" title="Next scheduled run">→ {new Date(monitorStatus.nextRunAt).toLocaleTimeString()}</span>
                            )}
                          </div>
                        </div>
                        <div className="max-h-32 overflow-y-auto">
                          {monitorStatus.recentActions.length > 0 ? (
                            <ul className="divide-y divide-gray-100">
                              {monitorStatus.recentActions.slice(0, 10).map((action, i) => (
                                <li key={i} className="px-3 py-1.5 text-[11px] text-gray-600 leading-snug">{action}</li>
                              ))}
                            </ul>
                          ) : (
                            <div className="px-3 py-2.5 text-[11px] text-gray-400 italic">No actions taken in last cycle</div>
                          )}
                        </div>
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
                      value={settings.projects_base_path ?? ""}
                      onChange={(e) => setSettings((s) => ({ ...s, projects_base_path: e.target.value }))}
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

              {/* Schedule tab */}
              {tab === "schedule" && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-500">
                    Configure recurring agent runs. Each scheduled run creates a direct workspace on its system issue at the configured interval.
                  </p>

                  {/* Existing runs */}
                  {scheduledRunsList.length === 0 ? (
                    <p className="text-sm text-gray-400 italic">No scheduled runs configured yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {scheduledRunsList.map((run) => (
                        <div key={run.id} className="border border-gray-200 rounded-md px-3 py-2 space-y-1">
                          {editingRun === run.id ? (
                            <div className="space-y-2">
                              <input
                                type="text"
                                value={editRunName}
                                onChange={(e) => setEditRunName(e.target.value)}
                                placeholder="Name"
                                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                autoFocus
                              />
                              <textarea
                                value={editRunPrompt}
                                onChange={(e) => setEditRunPrompt(e.target.value)}
                                placeholder="Prompt for the agent"
                                rows={3}
                                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                              />
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <label className="text-xs text-gray-600">Schedule:</label>
                                  <select
                                    value={editRunMode}
                                    onChange={(e) => setEditRunMode(e.target.value as "interval" | "cron")}
                                    className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                  >
                                    <option value="interval">Interval (minutes)</option>
                                    <option value="cron">Cron expression</option>
                                  </select>
                                </div>
                                {editRunMode === "interval" ? (
                                  <div className="flex items-center gap-2">
                                    <label className="text-xs text-gray-600 whitespace-nowrap">Every</label>
                                    <input
                                      type="number"
                                      min={1}
                                      value={editRunInterval}
                                      onChange={(e) => setEditRunInterval(Number(e.target.value))}
                                      className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                    />
                                    <span className="text-xs text-gray-600">minutes</span>
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <input
                                      type="text"
                                      value={editRunCron}
                                      onChange={(e) => setEditRunCron(e.target.value)}
                                      placeholder="e.g. 0 9 * * 1-5"
                                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                    />
                                    {editRunCron.trim() && (() => {
                                      const v = validateCronExpression(editRunCron);
                                      return v.valid
                                        ? <p className="text-xs text-green-600">{describeCronExpression(editRunCron)}</p>
                                        : <p className="text-xs text-red-500">{v.error}</p>;
                                    })()}
                                  </div>
                                )}
                                <div className="flex items-center gap-2">
                                  <button
                                    disabled={!editRunName.trim() || savingEditRun || (editRunMode === "cron" && (!editRunCron.trim() || !validateCronExpression(editRunCron).valid))}
                                    onClick={async () => {
                                      if (!editRunName.trim()) return;
                                      setSavingEditRun(true);
                                      try {
                                        const payload: Record<string, unknown> = { name: editRunName.trim(), prompt: editRunPrompt.trim() };
                                        if (editRunMode === "cron") {
                                          payload.cronExpression = editRunCron.trim();
                                          payload.intervalMinutes = 60;
                                        } else {
                                          payload.intervalMinutes = editRunInterval;
                                          payload.cronExpression = "";
                                        }
                                        await apiFetch(`/api/scheduled-runs/${run.id}`, { method: "PUT", body: JSON.stringify(payload) });
                                        setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, name: editRunName.trim(), prompt: editRunPrompt.trim(), intervalMinutes: editRunMode === "interval" ? editRunInterval : x.intervalMinutes, cronExpression: editRunMode === "cron" ? editRunCron.trim() : null } : x));
                                        setEditingRun(null);
                                        showToast("Scheduled run updated", "success");
                                      } catch {
                                        showToast("Failed to update", "error");
                                      } finally {
                                        setSavingEditRun(false);
                                      }
                                    }}
                                    className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                                  >
                                    {savingEditRun ? "Saving…" : "Save"}
                                  </button>
                                  <button
                                    onClick={() => setEditingRun(null)}
                                    className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={run.enabled}
                                  onChange={async (e) => {
                                    const enabled = e.target.checked;
                                    try {
                                      await apiFetch(`/api/scheduled-runs/${run.id}`, {
                                        method: "PUT",
                                        body: JSON.stringify({ enabled }),
                                      });
                                      setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, enabled } : x));
                                    } catch {
                                      showToast("Failed to update", "error");
                                    }
                                  }}
                                  className="rounded border-gray-300"
                                />
                                <span className="flex-1 text-sm font-medium text-gray-800">{run.name}</span>
                                <span className="text-xs text-gray-400">{run.cronExpression ? describeCronExpression(run.cronExpression) : `every ${run.intervalMinutes}m`}</span>
                                <button
                                  onClick={() => { setEditingRun(run.id); setEditRunName(run.name); setEditRunPrompt(run.prompt ?? ""); setEditRunInterval(run.intervalMinutes); setEditRunCron(run.cronExpression ?? ""); setEditRunMode(run.cronExpression ? "cron" : "interval"); }}
                                  className="text-xs text-gray-400 hover:text-blue-600"
                                >
                                  Edit
                                </button>
                                <button
                                  disabled={triggeringRun === run.id}
                                  onClick={async () => {
                                    setTriggeringRun(run.id);
                                    try {
                                      await apiFetch(`/api/scheduled-runs/${run.id}/run`, { method: "POST" });
                                      showToast("Run triggered", "success");
                                      const runs = await apiFetch<ScheduledRun[]>(`/api/scheduled-runs?projectId=${activeProjectId}`);
                                      setScheduledRunsList(runs);
                                    } catch { showToast("Trigger failed", "error"); }
                                    finally { setTriggeringRun(null); }
                                  }}
                                  className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded border border-blue-200"
                                >
                                  {triggeringRun === run.id ? "Running…" : "Run now"}
                                </button>
                                <button
                                  onClick={async () => {
                                    if (!confirm(`Delete scheduled run "${run.name}"?`)) return;
                                    try {
                                      await apiFetch(`/api/scheduled-runs/${run.id}`, { method: "DELETE" });
                                      setScheduledRunsList((r) => r.filter((x) => x.id !== run.id));
                                      showToast("Deleted", "success");
                                    } catch {
                                      showToast("Failed to delete", "error");
                                    }
                                  }}
                                  className="text-xs text-gray-400 hover:text-red-600"
                                >
                                  Delete
                                </button>
                              </div>
                              {run.prompt && (
                                <p className="text-xs text-gray-500 pl-5 truncate">{run.prompt}</p>
                              )}
                              {run.lastRunAt && (
                                <p className="text-xs text-gray-400 pl-5">
                                  Last run: {new Date(run.lastRunAt).toLocaleString()} — {run.lastRunStatus ?? "unknown"}
                                </p>
                              )}
                              {(() => {
                                const nextMs = run.lastRunAt
                                  ? new Date(run.lastRunAt).getTime() + run.intervalMinutes * 60 * 1000
                                  : null;
                                if (!run.enabled) return null;
                                if (nextMs === null) return (
                                  <p className="text-xs text-blue-500 pl-5">Next run: pending (first run)</p>
                                );
                                const diffMin = Math.round((nextMs - Date.now()) / 60000);
                                const label = diffMin <= 0
                                  ? "overdue"
                                  : diffMin < 60
                                    ? `in ${diffMin}m`
                                    : `at ${new Date(nextMs).toLocaleTimeString()}`;
                                return (
                                  <p className="text-xs text-blue-500 pl-5" title={new Date(nextMs).toLocaleString()}>
                                    Next run: {label}
                                  </p>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* New run form */}
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <p className="text-xs font-medium text-gray-600">Add scheduled run</p>
                    <input
                      type="text"
                      value={newRunName}
                      onChange={(e) => setNewRunName(e.target.value)}
                      placeholder="Name (e.g. Daily standup update)"
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <textarea
                      value={newRunPrompt}
                      onChange={(e) => setNewRunPrompt(e.target.value)}
                      placeholder="Prompt for the agent"
                      rows={3}
                      className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    />
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="text-xs text-gray-600">Schedule:</label>
                        <select
                          value={newRunMode}
                          onChange={(e) => setNewRunMode(e.target.value as "interval" | "cron")}
                          className="text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="interval">Interval (minutes)</option>
                          <option value="cron">Cron expression</option>
                        </select>
                      </div>
                      {newRunMode === "interval" ? (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-600 whitespace-nowrap">Every</label>
                          <input
                            type="number"
                            min={1}
                            value={newRunInterval}
                            onChange={(e) => setNewRunInterval(Number(e.target.value))}
                            className="w-20 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <span className="text-xs text-gray-600">minutes</span>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <input
                            type="text"
                            value={newRunCron}
                            onChange={(e) => setNewRunCron(e.target.value)}
                            placeholder="e.g. 0 9 * * 1-5  (weekdays at 09:00)"
                            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                          />
                          {newRunCron.trim() && (() => {
                            const v = validateCronExpression(newRunCron);
                            return v.valid
                              ? <p className="text-xs text-green-600">{describeCronExpression(newRunCron)}</p>
                              : <p className="text-xs text-red-500">{v.error}</p>;
                          })()}
                        </div>
                      )}
                      <button
                        disabled={!newRunName.trim() || !newRunPrompt.trim() || savingRun || !activeProjectId || (newRunMode === "cron" && (!newRunCron.trim() || !validateCronExpression(newRunCron).valid))}
                        onClick={async () => {
                          if (!newRunName.trim() || !newRunPrompt.trim() || !activeProjectId) return;
                          setSavingRun(true);
                          try {
                            const payload: Record<string, unknown> = { name: newRunName.trim(), prompt: newRunPrompt.trim(), projectId: activeProjectId };
                            if (newRunMode === "cron") {
                              payload.cronExpression = newRunCron.trim();
                              payload.intervalMinutes = 60;
                            } else {
                              payload.intervalMinutes = newRunInterval;
                            }
                            const created = await apiFetch<ScheduledRun>("/api/scheduled-runs", {
                              method: "POST",
                              body: JSON.stringify(payload),
                            });
                            setScheduledRunsList((r) => [...r, created]);
                            setNewRunName("");
                            setNewRunPrompt("");
                            setNewRunInterval(60);
                            setNewRunCron("");
                            setNewRunMode("interval");
                            showToast("Scheduled run created", "success");
                          } catch { showToast("Failed to create", "error"); }
                          finally { setSavingRun(false); }
                        }}
                        className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingRun ? "Creating…" : "Add"}
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
