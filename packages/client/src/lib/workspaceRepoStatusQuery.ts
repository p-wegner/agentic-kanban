import type { QueryClient } from "@tanstack/react-query";
import type { WorkspaceRepoStatusBatchResponse } from "@agentic-kanban/shared";
import { apiFetch } from "./api.js";
import { boardQueryKeys } from "./boardQueryKeys.js";

/**
 * The ONE shared transport for GET /api/projects/:id/workspace-repo-status (#415),
 * following the #403 workspacesListQuery pattern. The three cross-repo panels
 * (multi-repo matrix, cross-repo activity feed, impact heatmap) previously fanned out
 * N workspaces × {repo-merge-status, conflicts, handoff, diff} requests per WS burst —
 * ~300 git spawns server-side at N=20, M=3 repos. They now all read this one batched
 * query: in-flight dedupe collapses concurrent panel refreshes onto a single request,
 * and the freshness window matches the server's ~10s response memo.
 *
 * Every consumer requests the SAME include set on purpose — a per-panel include would
 * split the cache key and reintroduce parallel requests for overlapping data; the
 * server memoizes per include-set, so the union costs one computation.
 */

export const WORKSPACE_REPO_STATUS_INCLUDE = "merge,conflicts,handoff,diffstats";

/**
 * Freshness window — matches the server-side batch memo TTL, and is long enough that
 * the panels' differently-timed debounces (250ms / 1500ms) after one WS burst collapse
 * onto a single fetch.
 */
export const WORKSPACE_REPO_STATUS_STALE_MS = 10_000;

/**
 * Cached, deduped fetch of the project's batched cross-repo status. Returns cached
 * data when fresh, joins any in-flight request, and otherwise fetches — so N open
 * panels reacting to the same board event issue ONE network request between them.
 */
export function fetchWorkspaceRepoStatus(
  queryClient: QueryClient,
  projectId: string,
): Promise<WorkspaceRepoStatusBatchResponse> {
  return queryClient.fetchQuery({
    queryKey: boardQueryKeys.workspaceRepoStatus(projectId, WORKSPACE_REPO_STATUS_INCLUDE),
    queryFn: () =>
      apiFetch<WorkspaceRepoStatusBatchResponse>(
        `/api/projects/${projectId}/workspace-repo-status?include=${WORKSPACE_REPO_STATUS_INCLUDE}`,
      ),
    staleTime: WORKSPACE_REPO_STATUS_STALE_MS,
  });
}
