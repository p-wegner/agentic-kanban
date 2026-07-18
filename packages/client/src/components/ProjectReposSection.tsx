import { useCallback, useEffect, useState } from "react";
import type { ProjectRepoResponse } from "@agentic-kanban/shared";
import { apiDelete, apiFetch, apiPatch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { CollapsibleSection } from "./SettingsPanel.shared.js";
import { buildRepoPatch, repoFormFromResponse, type RepoEditFormState } from "./repoEditPayload.js";

/**
 * Multi-repo project settings: manage the ADDITIONAL repos (full-peers model).
 * The leading repo is the project's registered repoPath; every workspace gets a
 * worktree per additional repo on the same branch, and merge lands each repo
 * that has commits.
 */
export function ProjectReposSection({ projectId }: { projectId: string }) {
  const [repos, setRepos] = useState<ProjectRepoResponse[]>([]);
  const [mode, setMode] = useState<"path" | "clone">("path");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRepos(await apiFetch<ProjectRepoResponse[]>(`/api/projects/${projectId}/repos`));
    } catch {
      // section stays empty; non-fatal
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd() {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/repos`, mode === "clone" ? { cloneUrl: input.trim() } : { path: input.trim() });
      setInput("");
      await load();
      showToast("Repo added to project", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit(repo: ProjectRepoResponse, next: RepoEditFormState) {
    const patch = buildRepoPatch(repoFormFromResponse(repo), next);
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      return;
    }
    // Optimistic update; revert to server truth (via reload) on failure.
    const prev = repos;
    setRepos((rs) => rs.map((r) => (r.id === repo.id ? {
      ...r,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.setupScript !== undefined ? { setupScript: patch.setupScript } : {}),
      ...(patch.composeFile !== undefined ? { composeFile: patch.composeFile } : {}),
    } : r)));
    setEditingId(null);
    try {
      await apiPatch(`/api/projects/${projectId}/repos/${repo.id}`, patch);
      await load();
      showToast("Repo config saved", "success");
    } catch (err) {
      setRepos(prev);
      showToast(err instanceof Error ? err.message : "Failed to save repo config", "error");
    }
  }

  async function handleRemove(repoId: string) {
    try {
      await apiDelete(`/api/projects/${projectId}/repos/${repoId}`);
      await load();
      showToast("Repo removed from project", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to remove repo", "error");
    }
  }

  return (
    <CollapsibleSection
      title="Additional Repositories (multi-repo project)"
      configured={repos.length > 0}
      defaultOpen={repos.length > 0}
    >
      <p className="text-xs text-gray-500">
        Repos worked on alongside the leading repo. Every new workspace creates a worktree on the
        same branch in each of them (the agent starts in the leading repo's worktree); the diff
        aggregates across repos and merge lands each repo that has commits.
      </p>
      {repos.length > 0 && (
        <ul className="space-y-1">
          {repos.map((repo) => (
            <li key={repo.id} className="text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5">
              {editingId === repo.id ? (
                <RepoEditRow
                  repo={repo}
                  onCancel={() => setEditingId(null)}
                  onSave={(next) => void handleSaveEdit(repo, next)}
                />
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{repo.name ?? repo.path}</span>
                    <span className="block text-xs text-gray-500 font-mono truncate">{repo.path}{repo.defaultBranch ? ` (${repo.defaultBranch})` : ""}</span>
                    {(repo.setupScript || repo.composeFile) && (
                      <span className="block text-xs text-gray-400 font-mono truncate">
                        {repo.setupScript ? `setup: ${repo.setupScript}` : ""}
                        {repo.setupScript && repo.composeFile ? " · " : ""}
                        {repo.composeFile ? `compose: ${repo.composeFile}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setEditingId(repo.id)}
                      className="text-xs text-brand-600 hover:text-brand-800"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => void handleRemove(repo.id)}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <input type="radio" name={`repo-add-mode-${projectId}`} checked={mode === "path"} onChange={() => setMode("path")} className="h-3 w-3" />
          Local path
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
          <input type="radio" name={`repo-add-mode-${projectId}`} checked={mode === "clone"} onChange={() => setMode("clone")} className="h-3 w-3" />
          Clone from URL
        </label>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === "clone" ? "https://github.com/user/repo.git" : "C:/path/to/other-repo"}
          className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
        />
        <button
          onClick={() => void handleAdd()}
          disabled={busy || !input.trim()}
          className="text-sm px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </CollapsibleSection>
  );
}

/** Inline editor for one registered repo's name / setup script / compose file (#90). */
function RepoEditRow({
  repo,
  onSave,
  onCancel,
}: {
  repo: ProjectRepoResponse;
  onSave: (next: RepoEditFormState) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<RepoEditFormState>(() => repoFormFromResponse(repo));
  const nameEmpty = form.name.trim() === "";

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 font-mono truncate">{repo.path}</p>
      <label className="block text-xs text-gray-700 dark:text-gray-300">
        Name
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="display name"
          className="mt-0.5 w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="block text-xs text-gray-700 dark:text-gray-300">
        Setup script
        <input
          type="text"
          value={form.setupScript}
          onChange={(e) => setForm((f) => ({ ...f, setupScript: e.target.value }))}
          placeholder="pnpm install"
          className="mt-0.5 w-full text-sm border border-gray-300 rounded px-2 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      <label className="block text-xs text-gray-700 dark:text-gray-300">
        Compose file
        <input
          type="text"
          value={form.composeFile}
          onChange={(e) => setForm((f) => ({ ...f, composeFile: e.target.value }))}
          placeholder="docker-compose.yml"
          className="mt-0.5 w-full text-sm border border-gray-300 rounded px-2 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </label>
      {nameEmpty && <p className="text-xs text-red-600">Name must not be empty.</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(form)}
          disabled={nameEmpty}
          className="text-sm px-3 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="text-sm px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
