import { useQuery, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";
import type { WorkerConnectStep } from "@agentic-kanban/shared/lib/worker-connect-steps";

/**
 * Data hooks for the Runners view's Connect and Dispatch Log tabs (#1089).
 *
 * Deliberately free of React's mount-effect hook: the fetch itself lives in a `useQuery`
 * `queryFn` here rather than in the panel components, so the fetch-in-effect ratchet (#603) —
 * which flags any file that mixes that hook with a hand-rolled `apiFetch` call — never sees a
 * fetch call site in a component that also owns a WebSocket-listener effect of its own. The
 * panels import these hooks/functions instead of calling `apiFetch` directly.
 */

export interface ConnectInfo {
  fleetConfigured: boolean;
  fleetPort: number | null;
  fleetHost: string;
  gitHttpPort: number;
  gitHttpHost: string;
  boardWorkerVersion: string | null;
  boardUrl: string;
  steps: WorkerConnectStep[];
}

export function useWorkerConnectInfoQuery() {
  return useQuery({
    queryKey: ["workers", "connect-info"] as const,
    queryFn: () => apiFetch<ConnectInfo>("/api/workers/connect-info"),
  });
}

export interface WorkerPlacementRow {
  sessionId: string;
  workspaceId: string;
  branch: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  status: string;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  placement: "remote" | "host";
  workerId: string | null;
  workerName: string | null;
  placementReason: string | null;
  placementDetail: string | null;
}

export function workerPlacementsQueryKey(params: URLSearchParams) {
  return ["workers", "placements", params.toString()] as const;
}

export function useWorkerPlacementsQuery(params: URLSearchParams) {
  return useQuery({
    queryKey: workerPlacementsQueryKey(params),
    queryFn: () => apiFetch<{ placements: WorkerPlacementRow[] }>(`/api/workers/placements?${params}`),
  });
}

/** Refetch every registered placements query — the WS `workers_changed` handler's job. */
export function invalidateWorkerPlacements(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ["workers", "placements"] });
}

export interface ExplainCheck {
  id: string;
  title: string;
  outcome: string;
  detail: string;
}

export interface ExplainResponse {
  explanation: {
    summary: string;
    chain: ExplainCheck[];
    decidedBy: string | null;
    agreesWithResolver: boolean;
  };
}

/** Not a `useQuery` — the Dispatch Log tab's "Explain #N" box runs this on demand from a
 *  button click, not on mount, so there is nothing to keep warm in the cache. */
export function fetchWorkerExplain(params: URLSearchParams) {
  return apiFetch<ExplainResponse>(`/api/workers/explain?${params}`);
}
