import type { QueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";
import { boardQueryKeys } from "./boardQueryKeys.js";

/**
 * The ONE shared transport for `GET /api/workspaces?projectId=…&status=…` (#403).
 * Four panels (flight recorder, cross-repo activity, multi-repo matrix, impact
 * heatmap) previously issued independent uncached fetches that all re-fired on
 * the same WS events — opening the runtime feed alone produced two identical
 * slow list requests. Routing every consumer through one react-query key gives
 * in-flight dedupe (concurrent callers share a single request) plus a short
 * freshness window so a debounced WS burst across several open panels costs one
 * request total.
 */

/** Slim projection of GET /api/workspaces?projectId= (see server listWorkspacesSlim). */
export interface SlimWorkspaceListItem {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
  readyForMerge?: boolean;
  provider?: string | null;
  model?: string | null;
  mergedAt: string | null;
  isDirect: boolean;
  workingDir?: string | null;
  /** Not part of the slim projection today; kept optional for forward-compat readers. */
  latestSessionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Every non-terminal workspace status (terminal = closed/merged) — the allowlist
 * the #82 monitor established. An allowlist of only the running states would
 * silently drop `ready_for_merge`/`blocked`/`error` workspaces, and a
 * ready-for-merge workspace with stranded siblings is exactly the case (#69)
 * these panels exist to surface. Kept in sync with WorkspaceStatus.
 */
export const NON_CLOSED_WORKSPACE_STATUSES = [
  "active",
  "idle",
  "blocked",
  "reviewing",
  "fixing",
  "ready_for_merge",
  "awaiting-plan-approval",
  "error",
].join(",");

/**
 * Freshness window for the shared list. Long enough that the differently-timed
 * per-panel debounces (250ms and 1500ms) after one WS burst collapse onto a
 * single fetch; short enough that the next burst refetches.
 */
export const WORKSPACES_LIST_STALE_MS = 12_000;

/**
 * Cached, deduped fetch of a project's non-terminal workspace list. Returns the
 * cached rows when fresh (within {@link WORKSPACES_LIST_STALE_MS}), joins any
 * in-flight request, and otherwise fetches — so N open panels reacting to the
 * same event issue one network request between them.
 */
export function fetchWorkspacesList(
  queryClient: QueryClient,
  projectId: string,
  status: string = NON_CLOSED_WORKSPACE_STATUSES,
): Promise<SlimWorkspaceListItem[]> {
  return queryClient.fetchQuery({
    queryKey: boardQueryKeys.workspacesList(projectId, status),
    queryFn: () => apiFetch<SlimWorkspaceListItem[]>(`/api/workspaces?projectId=${projectId}&status=${status}`),
    staleTime: WORKSPACES_LIST_STALE_MS,
  });
}
