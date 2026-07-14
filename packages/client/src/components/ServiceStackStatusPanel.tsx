import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";

/**
 * Status panel for a workspace's per-workspace Docker service stack (project
 * `servicesConfig`). Renders nothing when the workspace has no stack. Mirrors
 * the SetupStatusPanel idiom: green while the stack is up, red with the compose
 * error when it failed to start, gray once torn down.
 */
export function ServiceStackStatusPanel({ serviceState }: { serviceState: WorkspaceResponse["serviceState"] }) {
  if (!serviceState) return null;

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
  const portEntries = Object.entries(serviceState.ports ?? {});
  return (
    <div className={`rounded border p-2 text-xs ${classNames[serviceState.status] ?? classNames.down}`} data-testid="workspace-service-stack-status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{labels[serviceState.status] ?? serviceState.status}</span>
        {portEntries.length > 0 && (
          <span>{portEntries.map(([name, port]) => `${name}:${port}`).join(", ")}</span>
        )}
        {serviceState.updatedAt && (
          <span title={serviceState.updatedAt}>{formatRelativeTime(serviceState.updatedAt)}</span>
        )}
      </div>
      <div className="mt-1 font-mono text-[11px] text-gray-700 dark:text-gray-300 truncate" title={serviceState.composeProjectName}>
        {serviceState.composeProjectName}
      </div>
      {serviceState.status === "error" && serviceState.error && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-white/70 dark:bg-black/20 p-1.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
          {serviceState.error}
        </pre>
      )}
    </div>
  );
}
