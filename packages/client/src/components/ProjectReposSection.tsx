import { useCallback, useEffect, useState } from "react";
import type { ProjectRepoResponse } from "@agentic-kanban/shared";
import { apiDelete, apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { CollapsibleSection } from "./SettingsPanel.shared.js";

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
            <li key={repo.id} className="flex items-center justify-between gap-2 text-sm border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5">
              <div className="min-w-0">
                <span className="font-medium">{repo.name ?? repo.path}</span>
                <span className="block text-xs text-gray-500 font-mono truncate">{repo.path}{repo.defaultBranch ? ` (${repo.defaultBranch})` : ""}</span>
              </div>
              <button
                onClick={() => void handleRemove(repo.id)}
                className="text-xs text-red-600 hover:text-red-800 shrink-0"
              >
                Remove
              </button>
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
