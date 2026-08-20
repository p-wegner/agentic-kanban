import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { StatusWithIssues, MilestoneResponse, ProjectRepoResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { boardQueryKeys } from "../lib/boardQueryKeys.js";
import { boardColumnsQueryOptions } from "../lib/boardColumnsQuery.js";
import { projectReposQueryOptions } from "../lib/projectReposQuery.js";
import type { Project } from "../lib/projectTypes.js";
import type { Tag } from "../lib/boardTypes.js";

// Re-exported so existing importers that pull the key factory from this module
// keep working; the canonical definition now lives in lib/boardQueryKeys.ts.
export { boardQueryKeys };

export function fetchTags() {
  return apiFetch<Tag[]>("/api/tags");
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: boardQueryKeys.projects,
    queryFn: () => apiFetch<Project[]>("/api/projects"),
    // /api/projects is one of the slowest endpoints and the list changes only on
    // explicit project management (which invalidates via the "projects" surface),
    // so mounting consumers (CreateIssuePanel, AllWorkspacesPanel, …) should not
    // refetch it for a minute (#403).
    staleTime: 60_000,
  });
}

export function useProjectReposQuery(projectId: string | null | undefined) {
  return useQuery({
    enabled: !!projectId,
    ...(projectId
      ? projectReposQueryOptions(projectId)
      : {
          queryKey: ["projects", "none", "repos"] as const,
          // Not `async`: react-query accepts a sync queryFn, and the `async` was only there to
          // match the sibling branch's shape (require-await).
          queryFn: () => [] as ProjectRepoResponse[],
        }),
  });
}

export function useArchivedProjectsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    // Archived projects are only shown in the project-management menu; fetching
    // them eagerly doubled cold-start load on the slowest endpoint. Callers pass
    // enabled: false until the menu actually needs the list.
    enabled: options?.enabled ?? true,
    queryKey: boardQueryKeys.archivedProjects,
    queryFn: async () => {
      const all = await apiFetch<Project[]>("/api/projects?includeArchived=true");
      return all.filter((p) => p.archivedAt);
    },
  });
}

export function useActiveProjectPreferenceQuery() {
  return useQuery({
    queryKey: boardQueryKeys.activeProjectPreference,
    queryFn: async () => {
      try {
        return await apiFetch<{ projectId: string | null }>("/api/preferences/active-project");
      } catch {
        return { projectId: null };
      }
    },
  });
}

/** The full react-query config the mounted board query runs with. Exported so a
 *  regression test can assert the hook goes through the ONE ETag-aware transport
 *  (`boardColumnsQueryOptions`) instead of a bare `apiFetch` — a bare queryFn on
 *  the same key overwrites the transport (last-applied queryFn wins), silently
 *  disabling the If-None-Match/304 path for every mount/reconnect (G11). */
export function boardQueryConfig(projectId: string | null, queryClient: QueryClient) {
  return {
    enabled: !!projectId,
    // Project switch: keep the previous key's data as placeholder so the query
    // never flashes `pending` while a cached board exists. The controller masks
    // cross-project placeholder rows via `isPlaceholderData`, so this only
    // affects status flags, never shows project A's issues under project B.
    placeholderData: keepPreviousData,
    ...(projectId
      ? boardColumnsQueryOptions(projectId, queryClient)
      : {
          queryKey: ["projects", "none", "board"] as const,
          queryFn: () => [] as StatusWithIssues[],
        }),
  };
}

export function useBoardQuery(projectId: string | null) {
  const queryClient = useQueryClient();
  return useQuery(boardQueryConfig(projectId, queryClient));
}

export function useSprintCapacityQuery(projectId: string | null) {
  return useQuery({
    enabled: !!projectId,
    queryKey: projectId ? boardQueryKeys.sprintCapacity(projectId) : ["projects", "none", "sprint-capacity"],
    queryFn: () => apiFetch<{ policy: { activeAgentsTarget: number } }>(`/api/projects/${projectId}/sprint-capacity`),
  });
}

export function useTagsQuery(projectId: string | null) {
  return useQuery({
    enabled: !!projectId,
    queryKey: boardQueryKeys.tags,
    queryFn: fetchTags,
  });
}

export function useMilestonesQuery(projectId: string | null) {
  return useQuery({
    enabled: !!projectId,
    queryKey: projectId ? boardQueryKeys.milestones(projectId) : ["projects", "none", "milestones"],
    queryFn: () => apiFetch<MilestoneResponse[]>(`/api/projects/${projectId}/milestones`),
  });
}
