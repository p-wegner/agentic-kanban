import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatusWithIssues, MilestoneResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { boardQueryKeys } from "../lib/boardQueryKeys.js";
import { fetchBoardColumns } from "../lib/boardColumnsQuery.js";
import type { Project, Tag } from "../routes/BoardPage.js";

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
  });
}

export function useArchivedProjectsQuery() {
  return useQuery({
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

export function useBoardQuery(projectId: string | null) {
  return useQuery({
    enabled: !!projectId,
    queryKey: projectId ? boardQueryKeys.board(projectId) : ["projects", "none", "board"],
    queryFn: () => apiFetch<StatusWithIssues[]>(`/api/projects/${projectId}/board`),
  });
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
