import { useEffect, useState } from "react";
import { apiPost, apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";

type ServiceState = NonNullable<WorkspaceResponse["serviceState"]>;

/** A stack control button — compact, disabled while any action is in flight. */
function ControlButton({
  label,
  title,
  onClick,
  disabled,
  className,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
  className: string;
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={title}
      className={`text-[10px] font-medium px-2 py-0.5 rounded disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {label}
    </button>
  );
}

/**
 * Status panel for a workspace's per-workspace Docker service stack (project
 * `servicesConfig`). Renders nothing when the workspace has no stack. Mirrors
 * the SetupStatusPanel idiom: green while the stack is up, red with the compose
 * error when it failed to start, gray once torn down.
 *
 * When `workspaceId` is supplied it also renders the lifecycle controls (#92):
 * Start / Stop / Restart / Rebuild / Retry and a "View logs" affordance, wired to
 * `POST /api/workspaces/:id/services/{up,down,restart}` and
 * `GET /api/workspaces/:id/services/logs`. Actions inapplicable to the current
 * state are disabled; the compose result is surfaced inline.
 */
export function ServiceStackStatusPanel({
  serviceState,
  workspaceId,
}: {
  serviceState: WorkspaceResponse["serviceState"];
  workspaceId?: string;
}) {
  // Local override so a control's result is reflected immediately (the board WS
  // refresh also re-flows the prop shortly after). Re-synced when the prop changes.
  const [state, setState] = useState<ServiceState | null>(serviceState ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    setState(serviceState ?? null);
  }, [serviceState]);

  if (!state) return null;

  const labels: Record<string, string> = {
    up: "Services up",
    error: "Services failed",
    down: "Services down",
  };
  const classNames: Record<string, string> = {
    up: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300",
    error: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
    down: "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300",
  };
  const portEntries = Object.entries(state.ports ?? {});
  const controlsEnabled = !!workspaceId;
  const provisioned = state.composeProjectName.length > 0 && (state.status === "up" || state.status === "down");
  const canRetry = state.status === "error"; // includes capacity-deferred stacks (deferred flag)

  async function runAction(kind: string, run: () => Promise<{ serviceState: ServiceState }>) {
    if (!workspaceId || busy) return;
    setBusy(kind);
    setActionError(null);
    try {
      const res = await run();
      setState(res.serviceState);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const start = () => runAction("start", () => apiPost(`/api/workspaces/${workspaceId}/services/up`));
  const retry = () => runAction("retry", () => apiPost(`/api/workspaces/${workspaceId}/services/up`));
  const stop = () => runAction("stop", () => apiPost(`/api/workspaces/${workspaceId}/services/down`));
  const restart = () => runAction("restart", () => apiPost(`/api/workspaces/${workspaceId}/services/restart`));
  const rebuild = () => runAction("rebuild", () => apiPost(`/api/workspaces/${workspaceId}/services/up?recreate=true`));

  async function viewLogs() {
    if (!workspaceId || logsLoading) return;
    if (logs !== null) { setLogs(null); return; } // toggle closed
    setLogsLoading(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ ok: boolean; logs: string }>(`/api/workspaces/${workspaceId}/services/logs?tail=200`);
      setLogs(res.logs || "(no output)");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <div
      className={`rounded border p-2 text-xs ${classNames[state.status] ?? classNames.down}`}
      data-testid="workspace-service-stack-status"
      onClick={controlsEnabled ? (e) => e.stopPropagation() : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{labels[state.status] ?? state.status}</span>
        {state.deferred && <span className="italic opacity-80">(deferred — capacity)</span>}
        {portEntries.length > 0 && (
          <span>{portEntries.map(([name, port]) => `${name}:${port}`).join(", ")}</span>
        )}
        {state.updatedAt && (
          <span title={state.updatedAt}>{formatRelativeTime(state.updatedAt)}</span>
        )}
      </div>
      <div className="mt-1 font-mono text-[11px] text-gray-700 dark:text-gray-300 truncate" title={state.composeProjectName}>
        {state.composeProjectName}
      </div>
      {state.status === "error" && state.error && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-white/70 dark:bg-black/20 p-1.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
          {state.error}
        </pre>
      )}

      {controlsEnabled && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="service-stack-controls">
          {state.status === "down" && (
            <ControlButton label="Start" title="Bring the stack up (reusing the allocated ports)" onClick={start} disabled={!!busy} className="bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300" />
          )}
          {state.status === "up" && (
            <ControlButton label="Stop" title="Stop the stack (containers removed, volumes kept)" onClick={stop} disabled={!!busy} className="bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200" />
          )}
          {state.status === "up" && (
            <ControlButton label="Restart" title="Restart the running containers" onClick={restart} disabled={!!busy} className="bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300" />
          )}
          {provisioned && (
            <ControlButton label="Rebuild" title="Recreate the containers (docker compose up --force-recreate)" onClick={rebuild} disabled={!!busy} className="bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300" />
          )}
          {canRetry && (
            <ControlButton label="Retry" title="Re-provision the stack (allocates ports and brings it up)" onClick={retry} disabled={!!busy} className="bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-300" />
          )}
          {state.composeProjectName.length > 0 && (
            <ControlButton label={logs !== null ? "Hide logs" : "View logs"} title="Show a recent tail of the container logs" onClick={viewLogs} disabled={logsLoading} className="bg-white/70 text-gray-700 hover:bg-white dark:bg-black/20 dark:text-gray-300 border border-gray-300 dark:border-gray-600" />
          )}
          {busy && (
            <span className="inline-flex items-center gap-1 text-[10px] opacity-80" data-testid="service-stack-busy">
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
              {busy}…
            </span>
          )}
        </div>
      )}

      {actionError && (
        <p className="mt-1 text-[11px] text-red-600 dark:text-red-400 break-all" data-testid="service-stack-action-error">
          {actionError}
        </p>
      )}

      {logs !== null && (
        <pre
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/80 dark:bg-black/50 p-2 font-mono text-[10px] text-gray-100"
          data-testid="service-stack-logs"
        >
          {logs}
        </pre>
      )}
    </div>
  );
}
