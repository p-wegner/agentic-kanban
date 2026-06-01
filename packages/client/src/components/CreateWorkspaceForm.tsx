import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { suggestBranchName, sanitizeBranchName } from "../lib/branch.js";
import type { IssueWithStatus, ProfileSelection, WorkspaceResponse } from "@agentic-kanban/shared";
import { CLAUDE_MODEL_OPTIONS } from "@agentic-kanban/shared";
import { PreflightModal } from "./PreflightModal.js";
import type { PreflightResult, PreflightClarification } from "./PreflightModal.js";
import {
  launchTemplatesKey,
  sanitizeLaunchTemplates,
  upsertLaunchTemplate,
  deleteLaunchTemplate,
  applyTemplateToForm,
  type LaunchTemplate,
  type LaunchTemplateOptions,
} from "../lib/launchTemplates.js";
import { showToast } from "./Toast.js";
import { LaunchPreviewPanel } from "./LaunchPreviewPanel.js";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript?: string | null;
}
interface CreateWorkspaceFormProps {
  issue: IssueWithStatus;
  project: Project | null;
  prefs: Record<string, string>;
  actionLoading: boolean;
  onCreated: (result: { id: string; sessionId?: string }) => void;
  onCancel: () => void;
  onSubmitting?: () => void;
  onSettled?: () => void;
}

type AgentProvider = ProfileSelection["provider"];

const COPILOT_DEFAULT_PROFILE = "default";
const CODEX_DEFAULT_PROFILE = "default";

function uniqueProfiles(profiles: string[], fallback?: string): string[] {
  const all = fallback ? [fallback, ...profiles] : profiles;
  return [...new Set(all.filter(Boolean))];
}

function defaultProfileLabel(prefs: Record<string, string>): string {
  if (prefs.provider === "codex") return `codex:${prefs.codex_profile || CODEX_DEFAULT_PROFILE}`;
  if (prefs.provider === "copilot") return `copilot:${prefs.copilot_profile || COPILOT_DEFAULT_PROFILE}`;
  return `claude:${prefs.claude_profile || "none"}`;
}

function profileOptionLabel(provider: AgentProvider, name: string): string {
  const isDefault = (provider === "copilot" && name === COPILOT_DEFAULT_PROFILE) ||
    (provider === "codex" && name === CODEX_DEFAULT_PROFILE);
  const displayName = isDefault ? "Default" : name;
  const providerLabel = provider === "codex" ? "Codex" : provider === "copilot" ? "Copilot" : "Claude";
  return `${providerLabel}: ${displayName}`;
}

export function CreateWorkspaceForm({ issue, project, prefs, actionLoading, onCreated, onCancel, onSubmitting, onSettled }: CreateWorkspaceFormProps) {
  const suggestion = suggestBranchName(issue);

  const [branchName, setBranchName] = useState(suggestion);
  const [baseBranch, setBaseBranch] = useState("");
  const [isDirect, setIsDirect] = useState(false);
  const [requiresReview, setRequiresReview] = useState(prefs.auto_review !== "false");
  // Per-launch override for the pre-flight check; defaults to the inherited `skip_preflight` setting.
  const [runPreflight, setRunPreflight] = useState(prefs.skip_preflight !== "true");
  const [planMode, setPlanMode] = useState(
    issue.priority === "high" || issue.priority === "critical",
  );
  const [tddMode, setTddMode] = useState(prefs.tdd_mode === "true");
  const [skipSetup, setSkipSetup] = useState(false);
  const [skipContextPacker, setSkipContextPacker] = useState(false);
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; description: string }[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [claudeProfiles, setClaudeProfiles] = useState<string[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([CODEX_DEFAULT_PROFILE]);
  const [copilotProfiles, setCopilotProfiles] = useState<string[]>([COPILOT_DEFAULT_PROFILE]);
  // selectedProfile format: "<provider>:<name>" e.g. "claude:myprofile", "codex:myprofile", "copilot:default", or "" for default
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  // When set, a pending launch payload is waiting for preflight confirmation
  const [pendingLaunch, setPendingLaunch] = useState<Record<string, unknown> | null>(null);

  // Launch templates state
  const [templates, setTemplates] = useState<LaunchTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [templateName, setTemplateName] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const templateSettingsKey = useMemo(() => project ? launchTemplatesKey(project.id) : "", [project]);

  useEffect(() => {
    if (project) {
      apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${project.id}/branches`)
        .then((data) => setBranches(data))
        .catch(() => setBranches(null));
    }
    Promise.all([
      apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles").catch(() => ({ profiles: [CODEX_DEFAULT_PROFILE] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [COPILOT_DEFAULT_PROFILE] })),
      apiFetch<Record<string, string>>("/api/preferences/settings").catch(() => ({} as Record<string, string>)),
    ]).then(([claudeData, codexData, copilotData, settings]) => {
      setClaudeProfiles(claudeData.profiles);
      setCodexProfiles(uniqueProfiles(codexData.profiles, CODEX_DEFAULT_PROFILE));
      setCopilotProfiles(uniqueProfiles(copilotData.profiles, COPILOT_DEFAULT_PROFILE));
      // Set default selection from global settings
      const globalProvider = settings.provider || "claude";
      if (globalProvider === "codex") {
        setSelectedProfile(`codex:${settings.codex_profile || CODEX_DEFAULT_PROFILE}`);
      } else if (globalProvider === "copilot") {
        setSelectedProfile(`copilot:${settings.copilot_profile || COPILOT_DEFAULT_PROFILE}`);
      } else if (settings.claude_profile) {
        setSelectedProfile(`claude:${settings.claude_profile}`);
      } else {
        setSelectedProfile("");
      }
      setSelectedModel(settings.default_model || "");
      // Per-project TDD preference (falls back to global tdd_mode)
      const projectTddKey = project ? `tdd_mode_${project.id}` : null;
      const tddPref = projectTddKey ? (settings[projectTddKey] ?? settings.tdd_mode) : settings.tdd_mode;
      setTddMode(tddPref === "true");
      // Load launch templates
      if (project) {
        const key = launchTemplatesKey(project.id);
        const loaded = sanitizeLaunchTemplates(settings[key]);
        setTemplates(loaded);
      }
    });
    const url = project ? `/api/agent-skills?projectId=${project.id}` : "/api/agent-skills";
    apiFetch<{ id: string; name: string; description: string }[]>(url)
      .then(setAvailableSkills)
      .catch(() => {});
  }, []);

  async function doLaunch(body: Record<string, unknown>) {
    setLocalLoading(true);
    setLocalError(null);
    onSubmitting?.();
    try {
      const result = await apiFetch<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // Persist TDD mode preference per-project (best-effort)
      if (project) {
        const prefKey = `tdd_mode_${project.id}`;
        apiFetch("/api/preferences/settings", {
          method: "PUT",
          body: JSON.stringify({ [prefKey]: String(tddMode) }),
        }).catch(() => {});
      }
      onCreated({ id: result.id, sessionId: result.sessionId });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to create workspace");
      setLocalLoading(false);
    } finally {
      onSettled?.();
    }
  }

  async function handleSubmit() {
    if (!isDirect && !branchName.trim()) return;

    const body: Record<string, unknown> = { issueId: issue.id, isDirect, requiresReview, planMode, tddMode, skipSetup, skipContextPacker };
    if (selectedSkillId) body.skillId = selectedSkillId;
    if (selectedProfile) {
      const colonIdx = selectedProfile.indexOf(":");
      if (colonIdx !== -1) {
        const provider = selectedProfile.slice(0, colonIdx) as AgentProvider;
        const name = selectedProfile.slice(colonIdx + 1);
        if ((provider === "claude" || provider === "codex" || provider === "copilot") && name) body.profile = { provider, name };
      }
    }
    if (isClaudeSelected && selectedModel) body.model = selectedModel;
    if (!isDirect) {
      body.branch = branchName.trim();
      if (baseBranch.trim()) {
        body.baseBranch = baseBranch.trim();
      }
    }

    // Skip preflight if opted out for this launch (defaults to the inherited setting)
    if (!runPreflight || !project) {
      await doLaunch(body);
      return;
    }

    // Run pre-flight check
    setPreflightLoading(true);
    setLocalError(null);
    try {
      const result = await apiFetch<PreflightResult>(`/api/issues/${issue.id}/preflight`, {
        method: "POST",
        body: JSON.stringify({ projectId: issue.projectId }),
      });
      // Surface the modal when the verdict blocks, OR when a complex ticket is being run
      // directly on the main checkout (advisory direct-workspace warning).
      const directRisk = isDirect && result.looksComplex === true;
      if (result.verdict === "ready" && !directRisk) {
        setPreflightLoading(false);
        await doLaunch(body);
      } else {
        setPendingLaunch(body);
        setPreflightResult(result);
        setPreflightLoading(false);
      }
    } catch {
      // If preflight fails (e.g. Claude unavailable), proceed with launch
      setPreflightLoading(false);
      await doLaunch(body);
    }
  }

  function handleCancel() {
    setBranchName("");
    setBaseBranch("");
    setIsDirect(false);
    setRequiresReview(false);
    setRunPreflight(prefs.skip_preflight !== "true");
    setPlanMode(false);
    setTddMode(false);
    setSkipSetup(false);
    setSkipContextPacker(false);
    onCancel();
  }

  async function persistTemplates(nextTemplates: LaunchTemplate[], message: string) {
    if (!templateSettingsKey) return false;
    setTemplateSaving(true);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ [templateSettingsKey]: JSON.stringify(nextTemplates) }),
      });
      setTemplates(nextTemplates);
      showToast(message, "success");
      return true;
    } catch {
      showToast("Failed to save launch template", "error");
      return false;
    } finally {
      setTemplateSaving(false);
    }
  }

  function handleApplyTemplate(templateId: string) {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const t = templates.find((tpl) => tpl.id === templateId);
    if (!t) return;
    const formState = applyTemplateToForm(t);
    if (formState.isDirect !== undefined) setIsDirect(formState.isDirect);
    if (formState.baseBranch !== undefined) setBaseBranch(formState.baseBranch);
    if (formState.requiresReview !== undefined) setRequiresReview(formState.requiresReview);
    if (formState.planMode !== undefined) setPlanMode(formState.planMode);
    if (formState.tddMode !== undefined) setTddMode(formState.tddMode);
    if (formState.skipSetup !== undefined) setSkipSetup(formState.skipSetup);
    if (formState.skipContextPacker !== undefined) setSkipContextPacker(formState.skipContextPacker);
    if (formState.selectedSkillId !== undefined) setSelectedSkillId(formState.selectedSkillId);
    if (formState.selectedProfile !== undefined) setSelectedProfile(formState.selectedProfile);
    if (formState.selectedModel !== undefined) setSelectedModel(formState.selectedModel);
  }

  async function handleSaveTemplate() {
    const name = templateName.trim();
    if (!name) return;
    const options: LaunchTemplateOptions = {
      baseBranch: baseBranch || undefined,
      selectedProfile: selectedProfile || undefined,
      selectedModel: selectedModel || undefined,
      selectedSkillId: selectedSkillId || undefined,
      planMode,
      tddMode,
      requiresReview,
      skipSetup,
      skipContextPacker,
      isDirect,
    };
    const next = upsertLaunchTemplate(templates, name, options);
    const saved = await persistTemplates(next, `Saved template "${name}"`);
    if (!saved) return;
    setTemplateName("");
    const savedTpl = next.find((tpl) => tpl.name.toLowerCase() === name.toLowerCase());
    setSelectedTemplateId(savedTpl?.id ?? "");
  }

  async function handleDeleteTemplate() {
    if (!selectedTemplateId) return;
    const t = templates.find((tpl) => tpl.id === selectedTemplateId);
    if (!t) return;
    const next = deleteLaunchTemplate(templates, selectedTemplateId);
    const deleted = await persistTemplates(next, `Deleted template "${t.name}"`);
    if (deleted) setSelectedTemplateId("");
  }

  const isLoading = actionLoading || localLoading || preflightLoading;
  const isClaudeSelected = selectedProfile === ""
    ? (prefs.provider !== "codex" && prefs.provider !== "copilot")
    : selectedProfile.startsWith("claude:");
  const defaultBranchLabel = project?.defaultBranch || "unset";
  const cannotCreateWorktree = !isDirect && !baseBranch.trim() && !project?.defaultBranch;

  return (
    <>
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2">
      {localError && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {localError}
        </div>
      )}
      {/* Launch template section */}
      <div className="border-b border-gray-200 dark:border-gray-700 pb-2 space-y-1.5">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">
          Launch Template
        </label>
        <div className="flex items-center gap-1.5">
          <select
            value={selectedTemplateId}
            onChange={(e) => handleApplyTemplate(e.target.value)}
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
            aria-label="Launch template"
          >
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {selectedTemplateId && (
            <button
              type="button"
              onClick={() => void handleDeleteTemplate()}
              disabled={templateSaving}
              className="rounded p-1 text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              aria-label="Delete template"
              title="Delete selected template"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSaveTemplate(); } }}
            placeholder="Template name"
            className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100 placeholder:text-gray-400"
            aria-label="Template name"
          />
          <button
            type="button"
            onClick={() => void handleSaveTemplate()}
            disabled={templateSaving || !templateName.trim()}
            className="text-xs font-medium text-gray-600 dark:text-gray-400 px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Save current options as a named template"
          >
            Save
          </button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={isDirect}
          onChange={(e) => setIsDirect(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Work directly on main checkout</span>
      </label>
      {isDirect && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Agent will work on the current branch of the main repository (no worktree created).
        </p>
      )}
      {!isDirect && (
        <>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">
            Branch Name
          </label>
          <input
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(sanitizeBranchName(e.target.value))}
            placeholder={suggestion}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          />
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mt-2">
            Base Branch
          </label>
          {branches ? (
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">Default ({defaultBranchLabel})</option>
              {branches.local.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
              {branches.remote.length > 0 && (
                <optgroup label="Remote">
                  {branches.remote.map((b) => (
                    <option key={`r/${b}`} value={b}>{b}</option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder={project?.defaultBranch || "Choose a base branch"}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
            />
          )}
          {cannotCreateWorktree && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Set a project default branch in settings or choose a base branch.
            </p>
          )}
        </>
      )}
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={requiresReview}
          onChange={(e) => setRequiresReview(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Request code review before merge</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={runPreflight}
          onChange={(e) => setRunPreflight(e.target.checked)}
          className="rounded border-gray-300"
          data-testid="run-preflight-checkbox"
        />
        <span>Run pre-flight check (AI ticket sanity check)</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={planMode}
          onChange={(e) => setPlanMode(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Plan mode (agent plans before implementing)</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={tddMode}
          onChange={(e) => setTddMode(e.target.checked)}
          className="rounded border-gray-300"
          data-testid="tdd-mode-checkbox"
        />
        <span>TDD mode (write failing AC tests before implementing)</span>
      </label>
      {project?.setupScript && (
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={skipSetup}
            onChange={(e) => setSkipSetup(e.target.checked)}
            className="rounded border-gray-300"
          />
          <span>Skip setup script</span>
        </label>
      )}
      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
        <input
          type="checkbox"
          checked={skipContextPacker}
          onChange={(e) => setSkipContextPacker(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Skip context packer (faster for simple tasks)</span>
      </label>
      {availableSkills.length > 0 && (
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">
            Agent Skill
          </label>
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">None (default)</option>
            {availableSkills.map((s) => (
              <option key={s.id} value={s.id}>{s.name} — {s.description}</option>
            ))}
          </select>
        </div>
      )}
      {(claudeProfiles.length > 0 || codexProfiles.length > 0 || copilotProfiles.length > 0) && (
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Profile</label>
          <select
            value={selectedProfile}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">Default ({defaultProfileLabel(prefs)})</option>
            {claudeProfiles.length > 0 && (
              <optgroup label="Claude">
                {claudeProfiles.map((p) => (
                  <option key={`claude:${p}`} value={`claude:${p}`}>{profileOptionLabel("claude", p)}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Codex">
              {codexProfiles.map((p) => (
                <option key={`codex:${p}`} value={`codex:${p}`}>{profileOptionLabel("codex", p)}</option>
              ))}
            </optgroup>
            <optgroup label="Copilot">
              {copilotProfiles.map((p) => (
                <option key={`copilot:${p}`} value={`copilot:${p}`}>{profileOptionLabel("copilot", p)}</option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
      {isClaudeSelected && (
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Model</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-900 dark:text-gray-100"
          >
            {CLAUDE_MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      )}
      <LaunchPreviewPanel
        issueId={issue.id}
        branch={branchName.trim()}
        baseBranch={baseBranch.trim()}
        isDirect={isDirect}
        requiresReview={requiresReview}
        planMode={planMode}
        tddMode={tddMode}
        skipSetup={skipSetup}
        skillId={selectedSkillId}
        selectedProfile={selectedProfile}
        selectedModel={selectedModel}
        disabled={isLoading || (!isDirect && !branchName.trim()) || cannotCreateWorktree}
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading || (!isDirect && !branchName.trim()) || cannotCreateWorktree}
          className="text-sm bg-brand-600 text-white px-3 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50"
        >
          {preflightLoading ? "Checking..." : isLoading ? "Creating..." : isDirect ? "Create Direct & Launch" : "Create & Launch"}
        </button>
        <button
          onClick={handleCancel}
          className="text-sm text-gray-500 dark:text-gray-400 px-3 py-1.5 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
    </div>
    {preflightResult && pendingLaunch && (
      <PreflightModal
        result={preflightResult}
        issueId={issue.id}
        projectId={issue.projectId}
        issueTitle={issue.title}
        issueDescription={issue.description ?? ""}
        isDirect={isDirect}
        loading={preflightLoading || localLoading}
        onLaunchAnyway={async () => {
          setPreflightResult(null);
          await doLaunch(pendingLaunch);
          setPendingLaunch(null);
        }}
        onAnswerAndLaunch={async (clarifications: PreflightClarification[]) => {
          // Re-run preflight with the answered clarifications. The server persists a
          // `preflight-clarification` comment and returns the markdown block to inject
          // into the launching agent's context.
          setPreflightLoading(true);
          try {
            const result = await apiFetch<PreflightResult>(`/api/issues/${issue.id}/preflight`, {
              method: "POST",
              body: JSON.stringify({ projectId: issue.projectId, clarifications }),
            });
            const launchBody = { ...pendingLaunch, clarifications: result.clarificationsBlock };
            if (result.verdict === "ready") {
              setPreflightResult(null);
              setPreflightLoading(false);
              await doLaunch(launchBody);
              setPendingLaunch(null);
            } else {
              // Still not ready — keep the (now answered) clarifications staged so a
              // subsequent "Launch anyway" still carries the injected context.
              setPendingLaunch(launchBody);
              setPreflightResult(result);
              setPreflightLoading(false);
            }
          } catch {
            // Preflight unavailable — proceed with the answered clarifications injected.
            const launchBody = {
              ...pendingLaunch,
              clarifications: clarifications.map((c) => `**Q:** ${c.question}\n**A:** ${c.answer}`).join("\n\n"),
            };
            setPreflightResult(null);
            setPreflightLoading(false);
            await doLaunch(launchBody);
            setPendingLaunch(null);
          }
        }}
        onRetry={async (_updatedTitle, _updatedDescription) => {
          // Re-run the preflight after the user saved edits
          setPreflightLoading(true);
          try {
            const result = await apiFetch<PreflightResult>(`/api/issues/${issue.id}/preflight`, {
              method: "POST",
              body: JSON.stringify({ projectId: issue.projectId }),
            });
            if (result.verdict === "ready") {
              setPreflightResult(null);
              setPreflightLoading(false);
              await doLaunch(pendingLaunch);
              setPendingLaunch(null);
            } else {
              setPreflightResult(result);
              setPreflightLoading(false);
            }
          } catch {
            setPreflightResult(null);
            setPreflightLoading(false);
            await doLaunch(pendingLaunch);
            setPendingLaunch(null);
          }
        }}
        onCancel={() => {
          setPreflightResult(null);
          setPendingLaunch(null);
        }}
      />
    )}
    </>
  );
}
