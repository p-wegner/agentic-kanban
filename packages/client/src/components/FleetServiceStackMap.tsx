import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectResponse, ServiceStackState, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";
import {
  buildFleetServiceStacks,
  type FleetServiceState,
  type FleetServiceStackMapData,
  type FleetStackInput,
} from "../lib/fleetServiceStacks.js";

/**
 * Fleet Service-Stack Map (#95). `ServiceStackStatusPanel` shows ONE workspace's
 * Docker stack; this lists EVERY active workspace's stack at once — each compose
 * service (named host port) grouped by workspace (and by the repo the compose
 * file lives in), with a header summary of running containers, allocated ports,
 * and unhealthy/exited count. It's the missing single view behind the "N
 * workspaces = N postgres" hazard.
 *
 * No new server endpoint: it reuses the same GET data the per-workspace panel
 * does — the slim project workspace list + each workspace's `serviceState` from
 * `GET /api/workspaces/:id` — and re-aggregates on every relevant board event so
 * it stays live without a second WebSocket.
 */

/** Non-terminal workspace statuses — the ones that can be running a stack. */
const NON_CLOSED_WORKSPACE_STATUSES = [
  "active",
  "idle",
  "blocked",
  "reviewing",
  "fixing",
  "ready_for_merge",
  "awaiting-plan-approval",
  "error",
].join(",");

/** Board-event reasons that can change a workspace's stack. */
const RELEVANT_REASONS = new Set<string>([
  "board_changed",
  "workspace_created",
  "workspace_setup",
  "workspace_merged",
  "workspace_closed",
  "workspace_updated",
  "session_completed",
  "session_launched",
  "session_stopped",
  "reconnect",
  "poll",
]);

const REFRESH_DEBOUNCE_MS = 1500;

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
}

const STATE_STYLES: Record<FleetServiceState, { label: string; badge: string; dot: string }> = {
  running: {
    label: "running",
    badge: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    dot: "bg-green-500",
  },
  deferred: {
    label: "deferred",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  error: {
    label: "unhealthy",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    dot: "bg-red-500",
  },
  stopped: {
    label: "stopped",
    badge: "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
    dot: "bg-gray-400",
  },
};

/** Load every active workspace's stack for a project and aggregate it, live. */
function useFleetServiceStacksData(
  projectId: string | null,
  columns: StatusWithIssues[],
): { data: FleetServiceStackMapData | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<FleetServiceStackMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const requestSeqRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [project, workspaces] = await Promise.all([
          apiFetch<ProjectResponse>(`/api/projects/${projectId}`).catch(() => null),
          apiFetch<SlimWorkspace[]>(
            `/api/workspaces?projectId=${projectId}&status=${NON_CLOSED_WORKSPACE_STATUSES}`,
          ),
        ]);
        // The compose file lives in one repo per project (composeRepo); null = leading.
        const repoName =
          project && typeof project.servicesConfig === "object" && project.servicesConfig
            ? (project.servicesConfig.composeRepo ?? null)
            : null;

        // Hydrate each workspace's serviceState from the details endpoint — the same
        // source the per-workspace panel uses. A failed fetch yields null (no stack).
        const states = await Promise.all(
          workspaces.map((w) =>
            apiFetch<{ serviceState?: ServiceStackState | null }>(`/api/workspaces/${w.id}`)
              .then((r) => r.serviceState ?? null)
              .catch(() => null),
          ),
        );

        // A newer refresh started while we were awaiting — drop this stale result.
        if (seq !== requestSeqRef.current) return;

        const issueById = new Map(columnsRef.current.flatMap((c) => c.issues).map((i) => [i.id, i]));
        const inputs: FleetStackInput[] = workspaces.map((w, i) => {
          const issue = issueById.get(w.issueId);
          return {
            workspaceId: w.id,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            branch: w.branch,
            repoName,
            serviceState: states[i],
          };
        });

        setData(buildFleetServiceStacks(inputs));
        setLoading(false);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  }, [projectId]);

  // Initial load (and reload when the project changes).
  useEffect(() => {
    load();
  }, [load]);

  // Coalesced live refresh on relevant board events (no new WebSocket).
  useEffect(() => {
    if (!projectId) return;
    const onBoardEvent = (e: Event) => {
      const detail = (e as CustomEvent<BoardWsEventDetail>).detail;
      if (!detail || detail.projectId !== projectId) return;
      if (!RELEVANT_REASONS.has(detail.reason)) return;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        load();
      }, REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener(BOARD_WS_EVENT, onBoardEvent);
    return () => {
      window.removeEventListener(BOARD_WS_EVENT, onBoardEvent);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [projectId, load]);

  return { data, loading, error, refresh: load };
}

/** Pure presentational fleet map — data in, markup out (no fetching/effects). */
export function FleetServiceStackMapView({
  data,
  loading,
  error,
}: {
  data: FleetServiceStackMapData | null;
  loading: boolean;
  error: string | null;
}) {
  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-48 text-red-500 dark:text-red-400 text-sm px-6 text-center">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
        {loading ? "Loading service stacks…" : "No data."}
      </div>
    );
  }

  const { groups, summary } = data;

  return (
    <div className="flex flex-col" data-testid="fleet-service-stack-map">
      {/* Header summary */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs"
        data-testid="fleet-stack-summary"
      >
        <span className="text-gray-700 dark:text-gray-200">
          <span className="font-semibold" data-testid="fleet-stack-count">{summary.stackCount}</span> stack
          {summary.stackCount === 1 ? "" : "s"}
        </span>
        <span className="text-green-700 dark:text-green-400">
          <span className="font-semibold" data-testid="fleet-running-count">{summary.runningContainers}</span> running
        </span>
        <span className="text-gray-600 dark:text-gray-300">
          <span className="font-semibold" data-testid="fleet-ports-count">{summary.allocatedPorts}</span> port
          {summary.allocatedPorts === 1 ? "" : "s"} allocated
        </span>
        <span className={summary.unhealthy > 0 ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500"}>
          <span className="font-semibold" data-testid="fleet-unhealthy-count">{summary.unhealthy}</span> unhealthy/exited
        </span>
      </div>

      {/* Grouped body */}
      {groups.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center"
          data-testid="fleet-stack-empty"
        >
          <p className="text-sm font-medium">No running service stacks</p>
          <p className="text-xs">
            Start a workspace whose project declares a Docker service stack to see it here.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {groups.map((group) => {
            const style = STATE_STYLES[group.state];
            return (
              <div key={group.workspaceId} className="px-4 py-3" data-testid="fleet-stack-group">
                {/* Workspace header */}
                <div className="flex items-center gap-2 flex-wrap mb-1.5">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
                  <span className="text-xs font-mono text-gray-800 dark:text-gray-200">
                    {group.issueNumber !== null ? `#${group.issueNumber}` : "—"}
                  </span>
                  {group.issueTitle && (
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate max-w-[220px]">
                      {group.issueTitle}
                    </span>
                  )}
                  <span
                    className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                    title="Repo the compose file lives in"
                  >
                    {group.repoName ?? "leading"}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${style.badge}`}>
                    {style.label}
                  </span>
                </div>

                {group.branch && (
                  <div className="ml-3.5 mb-1 text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate">
                    {group.branch}
                  </div>
                )}
                <div
                  className="ml-3.5 mb-2 text-[11px] font-mono text-gray-400 dark:text-gray-500 truncate"
                  title={group.composeProjectName}
                >
                  {group.composeProjectName}
                </div>

                {/* Service rows */}
                <div className="ml-3.5 flex flex-col gap-1">
                  {group.services.map((svc) => {
                    const svcStyle = STATE_STYLES[svc.state];
                    return (
                      <div
                        key={svc.name}
                        className="flex items-center gap-2 text-xs"
                        data-testid="fleet-stack-service"
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${svcStyle.dot}`} />
                        <span className="font-mono text-gray-700 dark:text-gray-200">{svc.name}</span>
                        {svc.hostPort !== null && (
                          <span className="font-mono text-gray-500 dark:text-gray-400">:{svc.hostPort}</span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${svcStyle.badge}`}>
                          {svcStyle.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface FleetServiceStackMapProps {
  projectId: string | null;
  columns: StatusWithIssues[];
}

/** Self-fetching, live-updating fleet map wired into the Multi-Repo Monitor. */
export function FleetServiceStackMap({ projectId, columns }: FleetServiceStackMapProps) {
  const { data, loading, error, refresh } = useFleetServiceStacksData(projectId, columns);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
        No active project selected.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-gray-100 dark:border-gray-800">
        <button
          onClick={refresh}
          disabled={loading}
          title="Refresh now"
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1.5 py-0.5 rounded"
        >
          ↻
        </button>
      </div>
      <FleetServiceStackMapView data={data} loading={loading} error={error} />
    </div>
  );
}
