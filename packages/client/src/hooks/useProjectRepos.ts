import { useMemo } from "react";
import { useProjectsQuery, useProjectReposQuery } from "./useBoardDataQueries.js";

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
 *
 * Reads through the shared react-query caches (#403): the leading repo name comes
 * from the `projects` list cache and the siblings from the shared `projectRepos`
 * query — so mounting a consumer (CreateIssuePanel, BoardFeedView) issues no
 * network request while those caches are warm.
 */
export function useProjectRepos(projectId: string | undefined): ProjectReposInfo {
  const projectsQuery = useProjectsQuery();
  const reposQuery = useProjectReposQuery(projectId);

  return useMemo(() => {
    if (!projectId) return { repos: [], isMultiRepo: false, loading: false };
    const leading = (projectsQuery.data ?? []).find((p) => p.id === projectId)?.repoName;
    const siblings = reposQuery.data ?? [];
    const names = [
      ...(leading ? [leading] : []),
      ...siblings.map((r) => r.name ?? baseName(r.path)),
    ];
    const seen = new Set<string>();
    const repos = names.filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // "loading" only while a cache is cold (first fetch, no data yet) — a background
    // refetch of warm data must not flicker consumers back into their loading state,
    // and a failed fetch resolves to "not loading" (empty list) like the old hook did.
    const loading = projectsQuery.isPending || reposQuery.isPending;
    return { repos, isMultiRepo: repos.length >= 2, loading };
  }, [projectId, projectsQuery.data, projectsQuery.isPending, reposQuery.data, reposQuery.isPending]);
}
