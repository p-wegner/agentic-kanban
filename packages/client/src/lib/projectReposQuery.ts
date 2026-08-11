import type { QueryClient } from "@tanstack/react-query";
import type { ProjectRepoResponse } from "@agentic-kanban/shared";
import { apiFetch } from "./api.js";
import { boardQueryKeys } from "./boardQueryKeys.js";

/**
 * The ONE shared transport for `GET /api/projects/:id/repos` (#403). The sibling
 * repo list was fetched uncached from ~5 call sites (board gate, create-workspace
 * form, multi-repo matrix, impact heatmap, useProjectRepos); it changes only via
 * the explicit repo-management UIs, so a long freshness window is safe as long as
 * those mutation paths call {@link invalidateProjectRepos}.
 */

/** Repo registrations change rarely (explicit management UI actions only). */
export const PROJECT_REPOS_STALE_MS = 60_000;

export function projectReposQueryOptions(projectId: string) {
  return {
    queryKey: boardQueryKeys.projectRepos(projectId),
    queryFn: () => apiFetch<ProjectRepoResponse[]>(`/api/projects/${projectId}/repos`),
    staleTime: PROJECT_REPOS_STALE_MS,
  };
}

/** Cached, in-flight-deduped fetch of a project's additional (sibling) repos. */
export function fetchProjectRepos(
  queryClient: QueryClient,
  projectId: string,
): Promise<ProjectRepoResponse[]> {
  return queryClient.fetchQuery(projectReposQueryOptions(projectId));
}

/** Call after any repo mutation (add/remove/edit/promote) so cached readers see it. */
export function invalidateProjectRepos(queryClient: QueryClient, projectId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: boardQueryKeys.projectRepos(projectId) });
}
