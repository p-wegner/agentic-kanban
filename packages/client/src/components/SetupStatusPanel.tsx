import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";

function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return "running";
  const sec = Math.floor(durationMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function SetupStatusPanel({ setup }: { setup: WorkspaceResponse["latestSetup"] }) {
  if (!setup) return null;

  const labels: Record<string, string> = {
    running: "Setup running",
    success: "Setup ready",
    skipped: "Setup skipped",
    failed: "Setup failed",
  };
  const classNames: Record<string, string> = {
    running: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
    success: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300",
    skipped: "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300",
    failed: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  };
  return (
    <div className={`rounded border p-2 text-xs ${classNames[setup.state] ?? classNames.skipped}`} data-testid="workspace-setup-status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{labels[setup.state] ?? setup.state}</span>
        <span>Duration {formatDurationMs(setup.durationMs)}</span>
        <span>Exit {setup.exitCode ?? "-"}</span>
        {setup.startedAt && (
          <span title={setup.startedAt}>{setup.state === "running" ? "Started" : "Ran"} {formatRelativeTime(setup.startedAt)}</span>
        )}
      </div>
      {setup.command && (
        <div className="mt-1 font-mono text-[11px] text-gray-700 dark:text-gray-300 truncate" title={setup.command}>
          {setup.command}
        </div>
      )}
      {(setup.stdoutTail || setup.stderrTail) && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-white/70 dark:bg-black/20 p-1.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
          {[
            setup.stdoutTail ? `stdout:\n${setup.stdoutTail}` : null,
            setup.stderrTail ? `stderr:\n${setup.stderrTail}` : null,
          ].filter(Boolean).join("\n\n")}
        </pre>
      )}
    </div>
  );
}
