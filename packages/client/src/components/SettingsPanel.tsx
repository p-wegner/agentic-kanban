import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { invalidateSettings } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";
import { useIssueTemplates } from "../hooks/useIssueTemplates.js";
import { CODEX_DEFAULT_PROFILE, COPILOT_DEFAULT_PROFILE, DEFAULT_SETTINGS, TABS, uniqueProfiles, type AgentProfileHealth, type McpHealth, type MonitorTunables, type ProjectSettingsState, type ScheduledRun, type Settings, type SettingsPanelProps, type SkillSetting, type Tab, type TagSetting } from "./SettingsPanel.shared.js";
import { AgentSettings } from "./settings/AgentSettings.js";
import { WorkflowSettings } from "./settings/WorkflowSettings.js";
import { SkillsSettings } from "./settings/SkillsSettings.js";
import { McpSettings } from "./settings/McpSettings.js";
import { AppearanceSettings } from "./settings/AppearanceSettings.js";
import { ProjectSettings } from "./settings/ProjectSettings.js";
import { TagsSettings } from "./settings/TagsSettings.js";
import { TemplatesSettings } from "./settings/TemplatesSettings.js";
import { ScheduleSettings } from "./settings/ScheduleSettings.js";
import { AdvancedSettingsSection } from "./SettingsPanel.shared.js";

export function SettingsPanel({ onClose, activeProjectId, boardToolsSlot }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([CODEX_DEFAULT_PROFILE]);
  const [copilotProfiles, setCopilotProfiles] = useState<string[]>([COPILOT_DEFAULT_PROFILE]);
  const [profileHealth, setProfileHealth] = useState<AgentProfileHealth[]>([]);
  const [preflightingProfileId, setPreflightingProfileId] = useState<string | null>(null);
  const [mcpHealth, setMcpHealth] = useState<McpHealth | null>(null);
  const [mcpProbing, setMcpProbing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("agent");

  // Project-specific settings
  const [projectSettings, setProjectSettings] = useState<ProjectSettingsState>({
    defaultBranch: "",
    setupScript: "",
    setupBlocking: true,
    setupEnabled: true,
    teardownScript: "",
    verifyScript: "",
    color: null,
    symlinkEnabled: false,
    symlinkDirs: "",
    defaultSkillId: null,
  });
  const [projectBranches, setProjectBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [generatingTeardown, setGeneratingTeardown] = useState(false);
  const [generatingVerify, setGeneratingVerify] = useState(false);

  // Skills state
  const [skills, setSkills] = useState<SkillSetting[]>([]);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState<{ name: string; description: string; prompt: string; model: string } | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Record<string, boolean>>({});
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);

  // Tags state
  const [tagsList, setTagsList] = useState<TagSetting[]>([]);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#6B7280");
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergingTags, setMergingTags] = useState(false);

  // Issue templates state
  const { customTemplates, templates: allIssueTemplates, MAX_TEMPLATES, add: addTemplate, update: updateTemplate, remove: removeTemplate } = useIssueTemplates();
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editTemplateName, setEditTemplateName] = useState("");
  const [editTemplateBody, setEditTemplateBody] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateBody, setNewTemplateBody] = useState("");

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
    maintenanceActive?: boolean;
    maintenanceEnd?: string | null;
  } | null>(null);

  const [monitorTunables, setMonitorTunables] = useState<{ tunables: MonitorTunables; source: "strategy" | "prefs" } | null>(null);
  const [migratingToStrategy, setMigratingToStrategy] = useState(false);

  // Provider divergence: global settings prefs vs the project's Strategy Bullseye
  const [providerDivergence, setProviderDivergence] = useState<{
    hasBullseye: boolean;
    bullseyeProvider: string | null;
    bullseyeProfile: string | null;
    settingsProvider: string | null;
    settingsProfile: string | null;
    diverged: boolean;
  } | null>(null);

  // Config export/import state
  const [configExporting, setConfigExporting] = useState(false);
  const [configImporting, setConfigImporting] = useState(false);
  const [configImportPreview, setConfigImportPreview] = useState<{
    statusChanges: { toAdd: unknown[]; toUpdate: unknown[] };
    prefChanges: Record<string, { from: string | undefined; to: string }>;
    strategyChanged: boolean;
    pendingFile: File;
  } | null>(null);

  async function handleConfigExport() {
    if (!activeProjectId || configExporting) return;
    setConfigExporting(true);
    try {
      const resp = await fetch(`/api/projects/${activeProjectId}/config/export`);
      if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `board-config-${activeProjectId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Config exported", "success");
    } catch {
      showToast("Export failed", "error");
    } finally {
      setConfigExporting(false);
    }
  }

  async function handleConfigImportFile(file: File) {
    if (!activeProjectId || configImporting) return;
    setConfigImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const preview = await apiFetch<{
        statusChanges: { toAdd: unknown[]; toUpdate: unknown[] };
        prefChanges: Record<string, { from: string | undefined; to: string }>;
        strategyChanged: boolean;
      }>(`/api/projects/${activeProjectId}/config/import?dryRun=true`, {
        method: "POST",
        body: formData,
      });
      setConfigImportPreview({ ...preview, pendingFile: file });
    } catch {
      showToast("Could not parse config file", "error");
    } finally {
      setConfigImporting(false);
    }
  }

  async function handleConfigImportConfirm() {
    if (!activeProjectId || !configImportPreview) return;
    setConfigImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", configImportPreview.pendingFile);
      await apiFetch(`/api/projects/${activeProjectId}/config/import`, {
        method: "POST",
        body: formData,
      });
      setConfigImportPreview(null);
      showToast("Config imported successfully", "success");
    } catch {
      showToast("Import failed", "error");
    } finally {
      setConfigImporting(false);
    }
  }

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
        const [data, profileData, codexProfileData, copilotProfileData, profileHealthData, mcpHealthData, skillsData, tagsData] = await Promise.all([
          apiFetch<Record<string, string>>("/api/preferences/settings"),
          apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles"),
          apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles"),
          apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [COPILOT_DEFAULT_PROFILE] })),
          apiFetch<{ profiles: AgentProfileHealth[] }>("/api/preferences/agent-profiles/health").catch(() => ({ profiles: [] })),
          apiFetch<McpHealth>("/api/preferences/mcp/health").catch(() => null),
          apiFetch<{ id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean }[]>("/api/agent-skills"),
          apiFetch<{ id: string; name: string; color: string | null; isBuiltin: boolean }[]>("/api/tags"),
        ]);
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setProfiles(profileData.profiles);
        setCodexProfiles(uniqueProfiles(codexProfileData.profiles, CODEX_DEFAULT_PROFILE));
        setCopilotProfiles(uniqueProfiles(copilotProfileData.profiles, COPILOT_DEFAULT_PROFILE));
        setProfileHealth(profileHealthData.profiles);
        setMcpHealth(mcpHealthData);
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

        // Check for provider/profile divergence between global settings and the Bullseye
        if (activeProjectId) {
          try {
            const div = await apiFetch<{ hasBullseye: boolean; bullseyeProvider: string | null; bullseyeProfile: string | null; settingsProvider: string | null; settingsProfile: string | null; diverged: boolean }>(
              `/api/preferences/provider-divergence?projectId=${activeProjectId}`
            );
            setProviderDivergence(div);
          } catch { /* non-fatal */ }
        }

        // Load project-specific settings
        if (activeProjectId) {
          try {
            const projects = await apiFetch<{ id: string; defaultBranch: string | null; setupScript: string | null; setupBlocking: boolean; color: string | null }[]>(("/api/projects"));
            const project = projects.find((p: any) => p.id === activeProjectId);
            if (project) {
              setProjectSettings({
                defaultBranch: project.defaultBranch || "",
                setupScript: project.setupScript || "",
                setupBlocking: project.setupBlocking !== false,
                setupEnabled: (project as any).setupEnabled !== false,
                teardownScript: (project as any).teardownScript || "",
                verifyScript: (data as Record<string, string>)[`verify_script_${activeProjectId}`] || "",
                color: project.color || null,
                symlinkEnabled: (project as any).symlinkEnabled === true,
                symlinkDirs: (project as any).symlinkDirs || "",
                defaultSkillId: (project as any).defaultSkillId || null,
              });
            }
            apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${activeProjectId}/branches`)
              .then(setProjectBranches)
              .catch(() => setProjectBranches(null));
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
    if (tab === "workflow") {
      fetchMonitorStatus();
      if (activeProjectId) fetchMonitorTunables();
    }
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

  async function fetchMonitorTunables() {
    if (!activeProjectId) return;
    try {
      const result = await apiFetch<{ tunables: MonitorTunables; source: "strategy" | "prefs" }>(
        `/api/projects/${activeProjectId}/monitor-tunables`,
      );
      setMonitorTunables(result);
    } catch { /* non-fatal */ }
  }

  async function handleMigrateToStrategy() {
    if (!activeProjectId || migratingToStrategy) return;
    setMigratingToStrategy(true);
    try {
      const wipLimit = parseInt(settings.nudge_wip_limit || "5", 10);
      const activeAgentsTarget = Number.isFinite(wipLimit) ? wipLimit : 5;
      const strategyConfig = {
        version: 1,
        activeAgentsTarget,
        backlogFloor: 3,
        maxNewStartsPerCycle: 3,
        segments: [],
      };
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ [`board_strategy_${activeProjectId}`]: JSON.stringify(strategyConfig) }),
      });
      invalidateSettings();
      showToast("Migrated to Strategy Bullseye", "success");
      await fetchMonitorTunables();
    } catch {
      showToast("Migration failed", "error");
    } finally {
      setMigratingToStrategy(false);
    }
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

  async function handleProfilePreflight(profile: AgentProfileHealth) {
    setPreflightingProfileId(profile.id);
    try {
      const result = await apiFetch<AgentProfileHealth["preflight"]>("/api/preferences/agent-profiles/preflight", {
        method: "POST",
        body: JSON.stringify({ provider: profile.provider, profileName: profile.profileName }),
      });
      setProfileHealth((rows) => rows.map((row) => row.id === profile.id
        ? { ...row, preflight: result, status: row.latestFailure ? "error" : result.status, command: result.command }
        : row));
      showToast(result.ok ? "Preflight passed" : "Preflight found issues", result.ok ? "success" : "error");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Preflight failed", "error");
    } finally {
      setPreflightingProfileId(null);
    }
  }

  async function handleMcpProbe() {
    setMcpProbing(true);
    try {
      const result = await apiFetch<McpHealth>("/api/preferences/mcp/probe", { method: "POST" });
      setMcpHealth(result);
      showToast(result.lastProbe?.ok ? "MCP probe passed" : "MCP probe found issues", result.lastProbe?.ok ? "success" : "error");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "MCP probe failed", "error");
    } finally {
      setMcpProbing(false);
    }
  }

  async function handleSave() {
    if (defaultBranchInvalid) {
      showToast("Default branch does not exist in this repo", "error");
      return;
    }
    setSaving(true);
    try {
      const settingsToSave = { ...settings };
      if (activeProjectId) {
        settingsToSave[`verify_script_${activeProjectId}` as keyof Settings] = projectSettings.verifyScript;
      }
      const promises: Promise<unknown>[] = [
        apiFetch("/api/preferences/settings", {
          method: "PUT",
          body: JSON.stringify(settingsToSave),
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
              color: projectSettings.color || null,
              defaultBranch: projectSettings.defaultBranch.trim() || null,
              symlinkEnabled: projectSettings.symlinkEnabled,
              symlinkDirs: projectSettings.symlinkDirs.trim() || null,
              defaultSkillId: projectSettings.defaultSkillId || null,
            }),
          }),
        );
      }
      await Promise.all(promises);
      // Invalidate BEFORE onClose: the close handler re-reads settings via the
      // shared store and must see the freshly saved values, not the cache.
      invalidateSettings();
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
  const defaultBranchValue = projectSettings.defaultBranch.trim();
  const defaultBranchInvalid = !!defaultBranchValue && !!projectBranches && !projectBranches.local.includes(defaultBranchValue);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-5xl bg-surface-raised dark:bg-surface-raised-dark rounded-xl shadow-2xl flex flex-col h-[90vh] max-h-[96vh] animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-ink dark:text-stone-100 heading-serif">Settings</h2>
          <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none">&times;</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
          ) : (
            <div className="space-y-5">
              {/* Agent tab */}
              {tab === "agent" && (
                <AgentSettings
                  settings={settings}
                  set={set}
                  setSettings={setSettings}
                  profiles={profiles}
                  codexProfiles={codexProfiles}
                  copilotProfiles={copilotProfiles}
                  profileHealth={profileHealth}
                  preflightingProfileId={preflightingProfileId}
                  onProfilePreflight={handleProfilePreflight}
                  activeProjectId={activeProjectId}
                  providerDivergence={providerDivergence}
                />
              )}

              {/* Workflow tab */}
              {tab === "workflow" && (
                <WorkflowSettings
                  settings={settings}
                  set={set}
                  setBool={setBool}
                  setSettings={setSettings}
                  activeProjectId={activeProjectId}
                  autoReviewOn={autoReviewOn}
                  monitorStatus={monitorStatus}
                  monitorTunables={monitorTunables}
                  monitorRunning={monitorRunning}
                  migratingToStrategy={migratingToStrategy}
                  skills={skills}
                  onRunMonitorNow={handleMonitorRunNow}
                  onMigrateToStrategy={handleMigrateToStrategy}
                />
              )}

              {/* Skills tab */}
              {tab === "skills" && (
                <SkillsSettings
                  skills={skills}
                  setSkills={setSkills}
                  editingSkill={editingSkill}
                  setEditingSkill={setEditingSkill}
                  newSkill={newSkill}
                  setNewSkill={setNewSkill}
                  installedSkills={installedSkills}
                  setInstalledSkills={setInstalledSkills}
                  installingSkill={installingSkill}
                  setInstallingSkill={setInstallingSkill}
                />
              )}

              {/* MCP Tools tab */}
              {tab === "mcp" && (
                <McpSettings
                  mcpHealth={mcpHealth}
                  mcpProbing={mcpProbing}
                  onMcpProbe={handleMcpProbe}
                  isToolDisabled={isToolDisabled}
                  toggleTool={toggleTool}
                />
              )}

              {/* UI tab */}
              {tab === "ui" && (
                <AppearanceSettings
                  boardToolsSlot={boardToolsSlot}
                  settings={settings}
                  set={set}
                  setBool={setBool}
                />
              )}

              {/* Project tab */}
              {tab === "project" && (
                <ProjectSettings
                  activeProjectId={activeProjectId}
                  settings={settings}
                  setSettings={setSettings}
                  projectSettings={projectSettings}
                  setProjectSettings={setProjectSettings}
                  projectBranches={projectBranches}
                  defaultBranchInvalid={defaultBranchInvalid}
                  generatingScript={generatingScript}
                  setGeneratingScript={setGeneratingScript}
                  generatingTeardown={generatingTeardown}
                  setGeneratingTeardown={setGeneratingTeardown}
                  generatingVerify={generatingVerify}
                  setGeneratingVerify={setGeneratingVerify}
                  skills={skills}
                  configExporting={configExporting}
                  configImporting={configImporting}
                  configImportPreview={configImportPreview}
                  setConfigImportPreview={setConfigImportPreview}
                  handleConfigExport={handleConfigExport}
                  handleConfigImportFile={handleConfigImportFile}
                  handleConfigImportConfirm={handleConfigImportConfirm}
                />
              )}

              {/* Tags tab */}
              {tab === "tags" && (
                <TagsSettings
                  tagsList={tagsList}
                  setTagsList={setTagsList}
                  editingTag={editingTag}
                  setEditingTag={setEditingTag}
                  editTagName={editTagName}
                  setEditTagName={setEditTagName}
                  editTagColor={editTagColor}
                  setEditTagColor={setEditTagColor}
                  newTagName={newTagName}
                  setNewTagName={setNewTagName}
                  newTagColor={newTagColor}
                  setNewTagColor={setNewTagColor}
                  selectedTagIds={selectedTagIds}
                  setSelectedTagIds={setSelectedTagIds}
                  mergeTargetId={mergeTargetId}
                  setMergeTargetId={setMergeTargetId}
                  mergingTags={mergingTags}
                  setMergingTags={setMergingTags}
                />
              )}

              {/* Templates tab */}
              {tab === "templates" && (
                <TemplatesSettings
                  customTemplates={customTemplates}
                  allIssueTemplates={allIssueTemplates}
                  MAX_TEMPLATES={MAX_TEMPLATES}
                  addTemplate={addTemplate}
                  updateTemplate={updateTemplate}
                  removeTemplate={removeTemplate}
                  editingTemplateId={editingTemplateId}
                  setEditingTemplateId={setEditingTemplateId}
                  editTemplateName={editTemplateName}
                  setEditTemplateName={setEditTemplateName}
                  editTemplateBody={editTemplateBody}
                  setEditTemplateBody={setEditTemplateBody}
                  newTemplateName={newTemplateName}
                  setNewTemplateName={setNewTemplateName}
                  newTemplateBody={newTemplateBody}
                  setNewTemplateBody={setNewTemplateBody}
                />
              )}

              {/* Schedule tab */}
              {tab === "schedule" && (
                <ScheduleSettings
                  activeProjectId={activeProjectId}
                  scheduledRunsList={scheduledRunsList}
                  setScheduledRunsList={setScheduledRunsList}
                  newRunName={newRunName}
                  setNewRunName={setNewRunName}
                  newRunPrompt={newRunPrompt}
                  setNewRunPrompt={setNewRunPrompt}
                  newRunInterval={newRunInterval}
                  setNewRunInterval={setNewRunInterval}
                  newRunCron={newRunCron}
                  setNewRunCron={setNewRunCron}
                  newRunMode={newRunMode}
                  setNewRunMode={setNewRunMode}
                  savingRun={savingRun}
                  setSavingRun={setSavingRun}
                  triggeringRun={triggeringRun}
                  setTriggeringRun={setTriggeringRun}
                  editingRun={editingRun}
                  setEditingRun={setEditingRun}
                  editRunName={editRunName}
                  setEditRunName={setEditRunName}
                  editRunPrompt={editRunPrompt}
                  setEditRunPrompt={setEditRunPrompt}
                  editRunInterval={editRunInterval}
                  setEditRunInterval={setEditRunInterval}
                  editRunCron={editRunCron}
                  setEditRunCron={setEditRunCron}
                  editRunMode={editRunMode}
                  setEditRunMode={setEditRunMode}
                  savingEditRun={savingEditRun}
                  setSavingEditRun={setSavingEditRun}
                />
              )}

              {/* Advanced tab */}
              {tab === "advanced" && (
                <AdvancedSettingsSection settings={settings} set={set} setBool={setBool} />
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
              disabled={saving || defaultBranchInvalid}
              className="px-4 py-2 text-sm text-white bg-brand-600 hover:bg-brand-700 rounded-md disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
