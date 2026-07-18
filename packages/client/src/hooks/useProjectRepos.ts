import { useEffect, useState } from "react";
import type { ProjectRepoResponse, ProjectResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

export interface ProjectReposInfo {
  /** All repos this project touches: leading repo first, then siblings (canonical names). */
  repos: string[];
  /** A project is "multi-repo" once it has at least one sibling repo (>= 2 total). */
  isMultiRepo: boolean;
  loading: boolean;
}

function baseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/**
 * The repo names a project spans (#94). Combines the leading repo (project.repoName)
 * with the additional/sibling repos. Single-repo projects return a one-element list,
 * so `isMultiRepo` gates all repo-aware authoring UI.
 */
export function useProjectRepos(projectId: string | undefined): ProjectReposInfo {
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setRepos([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      apiFetch<ProjectResponse[]>("/api/projects").catch(() => [] as ProjectResponse[]),
      apiFetch<ProjectRepoResponse[]>(`/api/projects/${projectId}/repos`).catch(() => [] as ProjectRepoResponse[]),
    ])
      .then(([projects, siblings]) => {
        if (cancelled) return;
        const leading = projects.find((p) => p.id === projectId)?.repoName;
        const names = [
          ...(leading ? [leading] : []),
          ...siblings.map((r) => r.name ?? baseName(r.path)),
        ];
        const seen = new Set<string>();
        setRepos(
          names.filter((n) => {
            const key = n.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { repos, isMultiRepo: repos.length >= 2, loading };
}
