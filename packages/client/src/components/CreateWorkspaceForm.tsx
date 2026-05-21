import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { suggestBranchName, sanitizeBranchName } from "../lib/branch.js";
import type { IssueWithStatus, WorkspaceResponse } from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
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
}

export function CreateWorkspaceForm({ issue, project, prefs, actionLoading, onCreated, onCancel }: CreateWorkspaceFormProps) {
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
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      apiFetch<{ local: string[]; remote: string[] }>(`/api/projects/${project.id}/branches`)
        .then((data) => setBranches(data))
        .catch(() => setBranches(null));
    }
    apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles")
      .then((data) => {
        setAvailableProfiles(data.profiles);
        apiFetch<Record<string, string>>("/api/preferences/settings")
          .then((s) => setSelectedProfile(s.claude_profile || ""))
          .catch(() => {});
      })
      .catch(() => {});
    const url = project ? `/api/agent-skills?projectId=${project.id}` : "/api/agent-skills";
    apiFetch<{ id: string; name: string; description: string }[]>(url)
      .then(setAvailableSkills)
      .catch(() => {});
  }, []);

  async function handleSubmit() {
    if (!isDirect && !branchName.trim()) return;
    setLocalLoading(true);
    setLocalError(null);
    try {
      const body: Record<string, unknown> = { issueId: issue.id, isDirect, requiresReview, planMode, skipSetup };
      if (selectedSkillId) body.skillId = selectedSkillId;
      if (selectedProfile) body.claudeProfile = selectedProfile;
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

  return (
    <div className="border border-gray-200 rounded p-3 space-y-2">
      {localError && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {localError}
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={isDirect}
          onChange={(e) => setIsDirect(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Work directly on main checkout</span>
      </label>
      {isDirect && (
        <p className="text-xs text-gray-400">
          Agent will work on the current branch of the main repository (no worktree created).
        </p>
      )}
      {!isDirect && (
        <>
          <label className="text-xs font-medium text-gray-600 block">
            Branch Name
          </label>
          <input
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(sanitizeBranchName(e.target.value))}
            placeholder={suggestion}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <label className="text-xs font-medium text-gray-600 block mt-2">
            Base Branch
          </label>
          {branches ? (
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Default ({project?.defaultBranch || "main"})</option>
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
              placeholder={project?.defaultBranch || "main"}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}
        </>
      )}
      <label className="flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={requiresReview}
          onChange={(e) => setRequiresReview(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Request code review before merge</span>
      </label>
      <label className="flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={planMode}
          onChange={(e) => setPlanMode(e.target.checked)}
          className="rounded border-gray-300"
        />
        <span>Plan mode (agent plans before implementing)</span>
      </label>
      {project?.setupScript && (
        <label className="flex items-center gap-2 text-xs text-gray-600">
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
          <label className="text-xs font-medium text-gray-600 block">
            Agent Skill
          </label>
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">None (default)</option>
            {availableSkills.map((s) => (
              <option key={s.id} value={s.id}>{s.name} — {s.description}</option>
            ))}
          </select>
        </div>
      )}
      {availableProfiles.length > 0 && (
        <div>
          <label className="text-xs font-medium text-gray-600 mb-1 block">Profile</label>
          <select
            value={selectedProfile}
            onChange={(e) => setSelectedProfile(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Default ({prefs.claude_profile || "none"})</option>
            {availableProfiles.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={isLoading || (!isDirect && !branchName.trim())}
          className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {isLoading ? "Creating..." : isDirect ? "Create Direct & Launch" : "Create & Launch"}
        </button>
        <button
          onClick={handleCancel}
          className="text-sm text-gray-500 px-3 py-1.5 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
