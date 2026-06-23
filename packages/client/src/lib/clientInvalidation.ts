import type { QueryClient } from "@tanstack/react-query";
import { boardQueryKeys } from "../hooks/useBoardDataQueries.js";
import { invalidateBundle } from "./issueDetailBundleCache.js";
import { invalidateSettings } from "./settingsStore.js";

export type ClientInvalidationEvent =
  | { surface: "board"; projectId: string }
  | { surface: "workspace"; projectId: string; issueId?: string }
  | { surface: "issue-detail"; projectId: string; issueId?: string }
  | { surface: "projects" }
  | { surface: "settings" }
  | { surface: "tags" }
  | { surface: "milestones"; projectId: string };

type Listener = (event: ClientInvalidationEvent) => void;

const listeners = new Set<Listener>();

const AVAILABLE_ISSUES_TTL_MS = 30_000;
const availableIssuesCache = new Map<string, { data: unknown[]; ts: number }>();

export function getCachedAvailableIssues<T>(projectId: string): T[] | null {
  const cached = availableIssuesCache.get(projectId);
  if (!cached || Date.now() - cached.ts >= AVAILABLE_ISSUES_TTL_MS) return null;
  return cached.data as T[];
}

export function setCachedAvailableIssues<T>(projectId: string, data: T[]): void {
  availableIssuesCache.set(projectId, { data, ts: Date.now() });
}

export function clearAvailableIssuesCache(projectId?: string): void {
  if (projectId) {
    availableIssuesCache.delete(projectId);
    return;
  }
  availableIssuesCache.clear();
}

export function subscribeClientInvalidations(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishClientInvalidation(event: ClientInvalidationEvent): void {
  for (const listener of listeners) listener(event);
}

function invalidateQueries(queryClient: QueryClient | null, event: ClientInvalidationEvent): Promise<unknown>[] {
  if (!queryClient) return [];
  switch (event.surface) {
    case "board":
      return [
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.board(event.projectId) }),
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.sprintCapacity(event.projectId) }),
      ];
    case "workspace":
      return [
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.board(event.projectId) }),
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.workspaceIssue(event.projectId, event.issueId) }),
      ];
    case "issue-detail":
      return [
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.issueDetail(event.projectId, event.issueId) }),
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.availableIssues(event.projectId) }),
      ];
    case "projects":
      return [
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: boardQueryKeys.archivedProjects }),
      ];
    case "settings":
      return [queryClient.invalidateQueries({ queryKey: boardQueryKeys.settings })];
    case "tags":
      return [queryClient.invalidateQueries({ queryKey: boardQueryKeys.tags })];
    case "milestones":
      return [queryClient.invalidateQueries({ queryKey: boardQueryKeys.milestones(event.projectId) })];
  }
}

function invalidateLocalCaches(event: ClientInvalidationEvent): void {
  switch (event.surface) {
    case "workspace":
      clearAvailableIssuesCache(event.projectId);
      if (event.issueId) invalidateBundle(event.issueId);
      return;
    case "issue-detail":
      clearAvailableIssuesCache(event.projectId);
      if (event.issueId) invalidateBundle(event.issueId);
      return;
    case "settings":
      invalidateSettings();
      return;
  }
}

export async function invalidateClientSurface(
  queryClient: QueryClient | null,
  event: ClientInvalidationEvent,
): Promise<void> {
  invalidateLocalCaches(event);
  publishClientInvalidation(event);
  await Promise.all(invalidateQueries(queryClient, event));
}

export function invalidateClientSurfaceLocal(event: ClientInvalidationEvent): void {
  invalidateLocalCaches(event);
  publishClientInvalidation(event);
}
