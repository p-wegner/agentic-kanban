import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { suggestBranchName, sanitizeBranchName } from "../lib/branch.js";
import type { IssueWithStatus, ProfileSelection, WorkspaceResponse } from "@agentic-kanban/shared";

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

export function CreateWorkspaceForm({ issue, project, prefs, actionLoading, onCreated, onCancel, onSubmitting }: CreateWorkspaceFormProps) {
  const suggestion = suggestBranchName(issue);

  const [branchName, setBranchName] = useState(suggestion);
  const [baseBranch, setBaseBranch] = useState("");
  const [isDirect, setIsDirect] = useState(false);
  const [requiresReview, setRequiresReview] = useState(prefs.auto_review !== "false");
  const [planMode, setPlanMode] = useState(false);
  const [skipSetup, setSkipSetup] = useState(false);
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null);
  const [availableSkills, setAvailableSkills] = useState<{ id: string; name: string; description: string }[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [claudeProfiles, setClaudeProfiles] = useState<string[]>([]);
  const [codexProfiles, setCodexProfiles] = useState<string[]>([CODEX_DEFAULT_PROFILE]);
  const [copilotProfiles, setCopilotProfiles] = useState<string[]>([COPILOT_DEFAULT_PROFILE]);
  // selectedProfile format: "<provider>:<name>" e.g. "claude:myprofile", "codex:myprofile", "copilot:default", or "" for default
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
    });
    const url = project ? `/api/agent-skills?projectId=${project.id}` : "/api/agent-skills";
    apiFetch<{ id: string; name: string; description: string }[]>(url)
      .then(setAvailableSkills)
      .catch(() => {});
  }, []);

  async function handleSubmit() {
    if (!isDirect && !branchName.trim()) return;
    setLocalLoading(true);
    setLocalError(null);
    onSubmitting?.();
    try {
      const body: Record<string, unknown> = { issueId: issue.id, isDirect, requiresReview, planMode, skipSetup };
      if (selectedSkillId) body.skillId = selectedSkillId;
      if (selectedProfile) {
        const colonIdx = selectedProfile.indexOf(":");
        if (colonIdx !== -1) {
          const provider = selectedProfile.slice(0, colonIdx) as AgentProvider;
          const name = selectedProfile.slice(colonIdx + 1);
          if ((provider === "claude" || provider === "codex" || provider === "copilot") && name) body.profile = { provider, name };
        }
      }
      if (!isDirect) {
        body.branch = branchName.trim();
        if (baseBranch.trim()) {
          body.baseBranch = baseBranch.trim();
        }
      }
      const result = await apiFetch<WorkspaceResponse & { sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onCreated({ id: result.id, sessionId: result.sessionId });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to create workspace");
      setLocalLoading(false);
    }
  }

  function handleCancel() {
    setBranchName("");
    setBaseBranch("");
    setIsDirect(false);
    setRequiresReview(false);
    setPlanMode(false);
    setSkipSetup(false);
    onCancel();
  }

  const isLoading = actionLoading || localLoading;
  const defaultBranchLabel = project?.defaultBranch || "unset";
  const cannotCreateWorktree = !isDirect && !baseBranch.trim() && !project?.defaultBranch;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2">
      {localError && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {localError}
        </div>
      )}
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
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
          />
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mt-2">
            Base Branch
          </label>
          {branches ? (
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
              className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
          checked={planMode}
          onChange={(e) => setPlanMode(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Plan mode (agent plans before implementing)</span>
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
      {availableSkills.length > 0 && (
        <div>
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block">
            Agent Skill
          </label>
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
            className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-900 dark:text-gray-100"
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
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading || (!isDirect && !branchName.trim()) || cannotCreateWorktree}
          className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {isLoading ? "Creating..." : isDirect ? "Create Direct & Launch" : "Create & Launch"}
        </button>
        <button
          onClick={handleCancel}
          className="text-sm text-gray-500 dark:text-gray-400 px-3 py-1.5 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
