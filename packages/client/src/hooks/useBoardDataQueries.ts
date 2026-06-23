import { useQuery } from "@tanstack/react-query";
import type { StatusWithIssues, MilestoneResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import type { Project, Tag } from "../routes/BoardPage.js";

export const boardQueryKeys = {
  activeProjectPreference: ["preferences", "active-project"] as const,
  archivedProjects: ["projects", "archived"] as const,
  availableIssues: (projectId: string) => ["projects", projectId, "available-issues"] as const,
  board: (projectId: string) => ["projects", projectId, "board"] as const,
  issueDetail: (projectId: string, issueId?: string) => ["projects", projectId, "issue-detail", issueId ?? "all"] as const,
  milestones: (projectId: string) => ["projects", projectId, "milestones"] as const,
  projects: ["projects", "active"] as const,
  settings: ["preferences", "settings"] as const,
  sprintCapacity: (projectId: string) => ["projects", projectId, "sprint-capacity"] as const,
  tags: ["tags"] as const,
  workspaceIssue: (projectId: string, issueId?: string) => ["projects", projectId, "workspaces", issueId ?? "all"] as const,
};

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
