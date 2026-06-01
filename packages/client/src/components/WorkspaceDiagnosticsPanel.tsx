import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getWorkspaceDevPorts } from "../lib/workspace-preview.js";
import type { WorkspaceResponse } from "@agentic-kanban/shared";
import { SetupStatusPanel } from "./SetupStatusPanel.js";

interface ProjectDiagnostics {
  setupScript?: string | null;
  setupEnabled?: boolean;
  setupBlocking?: boolean;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
}

function asJsonDirs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function statusClass(state: string | null | undefined): string {
  if (state === "success" || state === "linked" || state === "ready") return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
  if (state === "failed") return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  if (state === "running") return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
  return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
}

function compactMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const interesting = lines.find((line) =>
    /(error|failed|enoent|eacces|permission denied|address already in use|eaddrinuse|cannot find module|command not found|not recognized)/i.test(line)
  );
  return (interesting ?? lines.at(-1) ?? null)?.slice(0, 280) ?? null;
}

function failureMessages(workspace: WorkspaceResponse): string[] {
  const messages = [
    compactMessage(workspace.latestSetup?.stderrTail),
    compactMessage(workspace.latestSetup?.stdoutTail),
    workspace.latestSymlink?.error ?? null,
    ...(workspace.latestSymlink?.failed.map((failure) => `${failure.dir}: ${failure.error}`) ?? []),
  ].filter((message): message is string => !!message);
  return [...new Set(messages)].slice(0, 4);
}

function DiagnosticsRow({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gray-100 dark:border-gray-800 py-2 last:border-0">
      <div>
        <div className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</div>
        {detail && <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 break-all">{detail}</div>}
      </div>
      <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${statusClass(value)}`}>
        {value}
      </span>
    </div>
  );
}

export function WorkspaceDiagnosticsPanel({ workspace, project }: { workspace: WorkspaceResponse; project: ProjectDiagnostics | null }) {
  const ports = getWorkspaceDevPorts(workspace);
  const symlink = workspace.latestSymlink;
  const configuredSymlinkDirs = asJsonDirs(project?.symlinkDirs);
  const failures = failureMessages(workspace);
  const setupConfigured = !!project?.setupScript;

  const setupState = workspace.latestSetup?.state
    ?? (setupConfigured ? (project?.setupEnabled === false ? "skipped" : "pending") : "skipped");
  const symlinkState = symlink?.state
    ?? (project?.symlinkEnabled ? "pending" : "disabled");

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-2">
        <DiagnosticsRow
          label="Setup script"
          value={setupState}
          detail={workspace.latestSetup?.command ?? project?.setupScript ?? "No setup script configured"}
        />
        <DiagnosticsRow
          label="Dependency symlinks"
          value={symlinkState}
          detail={
            symlink
              ? `${symlink.dirs.length} configured, ${symlink.linked.length} linked, ${symlink.skipped.length} skipped, ${symlink.failed.length} failed`
              : project?.symlinkEnabled
                ? configuredSymlinkDirs.join(", ") || "Enabled with no directories configured"
                : "Disabled"
          }
        />
        <DiagnosticsRow
          label="Dev ports"
          value={ports.ok ? "ready" : "failed"}
          detail={ports.ok ? `server ${ports.serverPort}, client ${ports.clientPort}` : ports.reason}
        />
        <DiagnosticsRow
          label="Dev-server bootstrap"
          value={workspace.workingDir && ports.ok ? "ready" : "skipped"}
          detail={
            workspace.workingDir && ports.ok
              ? `Agent env: server=${ports.serverPort}, client=${ports.clientPort}`
              : "No working directory available for dev-server bootstrap"
          }
        />
      </div>

      {workspace.latestSetup && <SetupStatusPanel setup={workspace.latestSetup} />}

      {symlink && (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-gray-700 dark:text-gray-300">Symlink result</span>
            <span className={`rounded px-1.5 py-0.5 ${statusClass(symlink.state)}`}>{symlink.state}</span>
            {symlink.startedAt && <span title={symlink.startedAt}>{formatRelativeTime(symlink.startedAt)}</span>}
          </div>
          {symlink.linked.length > 0 && <p className="mt-1 text-green-700 dark:text-green-300">Linked: {symlink.linked.join(", ")}</p>}
          {symlink.skipped.length > 0 && <p className="mt-1 text-gray-500 dark:text-gray-400">Skipped: {symlink.skipped.join(", ")}</p>}
          {symlink.failed.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-red-700 dark:text-red-300">
              {symlink.failed.map((failure) => (
                <li key={`${failure.dir}:${failure.error}`}><span className="font-mono">{failure.dir}</span>: {failure.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {ports.ok && (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-2 text-xs text-gray-600 dark:text-gray-400">
          <div className="font-semibold text-gray-700 dark:text-gray-300">Preview</div>
          <div className="mt-1 font-mono break-all">{ports.previewUrl}</div>
        </div>
      )}

      {failures.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-semibold">Failure messages</div>
          <ul className="mt-1 space-y-1">
            {failures.map((message) => <li key={message} className="font-mono break-all">{message}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
