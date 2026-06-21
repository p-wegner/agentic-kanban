import type { Dispatch, SetStateAction } from "react";
import { apiFetch, apiPost, apiPut, apiDelete } from "../../lib/api.js";
import { describeCronExpression } from "../../lib/cron-utils.js";
import { deriveLastRunDisplay } from "../../lib/scheduled-run-form.js";
import { formatNextFire, formatScheduledRunTime, type ScheduledRun } from "../SettingsPanel.shared.js";
import { showToast } from "../Toast.js";

type ScheduledRunRowProps = {
  run: ScheduledRun;
  activeProjectId?: string | null;
  triggeringRun: string | null;
  setTriggeringRun: Dispatch<SetStateAction<string | null>>;
  setScheduledRunsList: Dispatch<SetStateAction<ScheduledRun[]>>;
  onStartEdit: () => void;
};

/** Read-only summary of one scheduled run with its enable/pause/run/edit/delete controls. */
export function ScheduledRunRow({ run, activeProjectId, triggeringRun, setTriggeringRun, setScheduledRunsList, onStartEdit }: ScheduledRunRowProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={run.enabled}
          onChange={async (e) => {
            const enabled = e.target.checked;
            try {
              await apiPut(`/api/scheduled-runs/${run.id}`, { enabled });
              setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, enabled } : x));
            } catch {
              showToast("Failed to update", "error");
            }
          }}
          className="rounded border-gray-300"
        />
        <span className="flex-1 text-sm font-medium text-gray-800">{run.name}</span>
        <span className="text-xs text-gray-400">{run.cronExpression ? describeCronExpression(run.cronExpression) : `every ${run.intervalMinutes}m`}</span>
        <button
          onClick={async () => {
            const enabled = !run.enabled;
            try {
              await apiPut(`/api/scheduled-runs/${run.id}`, { enabled });
              setScheduledRunsList((r) => r.map((x) => x.id === run.id ? { ...x, enabled, nextFireAt: enabled ? x.nextFireAt : null } : x));
              showToast(enabled ? "Scheduled run resumed" : "Scheduled run paused", "success");
            } catch {
              showToast("Failed to update", "error");
            }
          }}
          className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded border border-gray-200"
        >
          {run.enabled ? "Pause" : "Resume"}
        </button>
        <button
          onClick={onStartEdit}
          className="text-xs text-gray-400 hover:text-brand-600"
        >
          Edit
        </button>
        <button
          disabled={triggeringRun === run.id}
          onClick={async () => {
            setTriggeringRun(run.id);
            try {
              await apiPost(`/api/scheduled-runs/${run.id}/run`);
              showToast("Run triggered", "success");
              const runs = await apiFetch<ScheduledRun[]>(`/api/scheduled-runs?projectId=${activeProjectId}`);
              setScheduledRunsList(runs);
            } catch { showToast("Trigger failed", "error"); }
            finally { setTriggeringRun(null); }
          }}
          className="text-xs px-2 py-1 text-brand-600 hover:bg-brand-50 rounded border border-brand-200"
        >
          {triggeringRun === run.id ? "Running…" : "Run now"}
        </button>
        <button
          onClick={async () => {
            if (!confirm(`Delete scheduled run "${run.name}"?`)) return;
            try {
              await apiDelete(`/api/scheduled-runs/${run.id}`);
              setScheduledRunsList((r) => r.filter((x) => x.id !== run.id));
              showToast("Deleted", "success");
            } catch {
              showToast("Failed to delete", "error");
            }
          }}
          className="text-xs text-gray-400 hover:text-red-600"
        >
          Delete
        </button>
      </div>
      {run.prompt && (
        <p className="text-xs text-gray-500 pl-5 truncate">{run.prompt}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 pl-5 text-xs text-gray-500">
        <p>
          Issue: {run.systemIssue ? (
            <span className="font-medium text-gray-700">#{run.systemIssue.issueNumber} {run.systemIssue.title}</span>
          ) : run.systemIssueId ? (
            <span className="text-red-600">missing issue</span>
          ) : (
            <span>none</span>
          )}
        </p>
        <p>
          Workspace: {run.lastRunWorkspace ? (
            <span className="font-medium text-gray-700">{run.lastRunWorkspace.branch} ({run.lastRunWorkspace.status})</span>
          ) : run.lastRunWorkspaceId ? (
            <span className="text-red-600">missing workspace</span>
          ) : (
            <span>none</span>
          )}
        </p>
      </div>
      {run.lastRunAt ? (() => {
        const { status, icon, colorClass } = deriveLastRunDisplay(run.lastRunStatus);
        const timeStr = new Date(run.lastRunAt).toLocaleString('en-US');
        const content = (
          <span className={`font-medium ${colorClass}`}>{icon} {status}</span>
        );
        return (
          <p className="text-xs text-gray-400 pl-5" title={timeStr}>
            Last run: {timeStr} — {run.lastRunWorkspaceId ? (
              <button
                className={`underline font-medium ${colorClass} hover:opacity-75`}
                onClick={() => {
                  // Navigate to workspace output — emit a custom event the parent can handle
                  window.dispatchEvent(new CustomEvent("open-workspace", { detail: { workspaceId: run.lastRunWorkspaceId } }));
                }}
              >{icon} {status}</button>
            ) : content}
          </p>
        );
      })() : (
        <p className="text-xs text-gray-400 pl-5">Never run</p>
      )}
      <p className={`text-xs pl-5 ${run.enabled ? "text-blue-500" : "text-gray-400"}`} title={formatScheduledRunTime(run.nextFireAt)}>
        Next run: {run.enabled ? formatNextFire(run.nextFireAt) : "paused"}
      </p>
      {run.latestHistory?.reason && (
        <p className="text-xs text-red-600 pl-5">
          Last reason: {run.latestHistory.reason}
        </p>
      )}
      {run.history && run.history.length > 0 && (
        <details className="pl-5">
          <summary className="text-xs text-gray-500 cursor-pointer">Recent history</summary>
          <div className="mt-1 space-y-1">
            {run.history.map((entry) => (
              <div key={entry.id} className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                <span className="font-medium text-gray-700">{entry.status}</span>
                <span>{formatScheduledRunTime(entry.startedAt)}</span>
                <span>{entry.triggeredBy}</span>
                {entry.reason && <span className="text-red-600">{entry.reason}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
