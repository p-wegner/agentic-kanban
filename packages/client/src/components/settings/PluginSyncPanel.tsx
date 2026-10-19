import { useState } from "react";
import type { PluginSyncRunRecord, PluginSyncStatusView } from "@agentic-kanban/shared";
import { apiPost } from "../../lib/api.js";
import { useApiResource } from "../../hooks/useApiResource.js";
import { showToast } from "../../lib/toast.js";

type Props = { pluginRowId: string; projectId: string };

const BUTTON_CLASS =
  "text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50";

function scheduleLabel(minutes: number): string {
  return minutes > 0 ? `every ${minutes} min` : "off";
}

function RunLine({ label, run }: { label: string; run: PluginSyncRunRecord | null }) {
  if (!run) {
    return <div className="text-xs text-gray-500" data-testid={`plugin-sync-run-${label}`}>{label}: no run yet</div>;
  }
  const counts = run.summary?.counts ?? {};
  const countText = Object.entries(counts)
    .filter(([, n]) => typeof n === "number")
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return (
    <div className="text-xs space-y-0.5" data-testid={`plugin-sync-run-${label}`}>
      <div className={run.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
        <span className="font-medium">{label}</span>
        {run.dryRun ? " (dry run)" : ""}
        {run.scheduled ? " (scheduled)" : ""}: {run.ok ? "ok" : "failed"}
        <span className="text-gray-500"> at {new Date(run.finishedAt).toLocaleString("en-US")}</span>
        {countText ? <span className="text-gray-600 dark:text-gray-300"> - {countText}</span> : null}
      </div>
      {run.error && <div className="text-red-700 dark:text-red-400 whitespace-pre-wrap break-words">{run.error}</div>}
      {(run.summary?.conflicts ?? []).map((c) => (
        <div key={`c-${c.externalKey}`} className="pl-3 text-amber-700 dark:text-amber-400">
          conflict{" "}
          {c.externalUrl ? <a href={c.externalUrl} target="_blank" rel="noreferrer" className="underline">{c.externalKey}</a> : c.externalKey}
          : {c.reason}
        </div>
      ))}
      {(run.summary?.failures ?? []).map((f, i) => (
        <div key={`f-${f.externalKey}-${i}`} className="pl-3 text-red-700 dark:text-red-400">
          failed{" "}
          {f.externalUrl ? <a href={f.externalUrl} target="_blank" rel="noreferrer" className="underline">{f.externalKey}</a> : f.externalKey}
          : {f.reason}
        </div>
      ))}
    </div>
  );
}

/**
 * The per-project Sync panel (#1625): Pull now / Push now / Dry run, the last run per direction
 * with counts, failures and conflicts (linked to Jira), the outbox length, and the schedule.
 * Settings and secrets live in `PluginSyncSettings`; the schedule is two of its config fields.
 */
export function PluginSyncPanel({ pluginRowId, projectId }: Props) {
  const resource = useApiResource<PluginSyncStatusView>(
    `/api/plugins/${pluginRowId}/sync/status?projectId=${encodeURIComponent(projectId)}`,
    { fallbackError: "Could not load sync status" },
  );
  const status = resource.data;
  const [running, setRunning] = useState<string | null>(null);

  async function trigger(direction: "pull" | "push", dryRun: boolean) {
    const id = `${direction}${dryRun ? "-dry" : ""}`;
    setRunning(id);
    try {
      const run = await apiPost<PluginSyncRunRecord>(`/api/plugins/${pluginRowId}/sync/trigger`, { projectId, direction, dryRun });
      showToast(run.ok ? `${direction}${dryRun ? " dry run" : ""} finished` : `${direction} failed: ${run.error ?? "see the sync panel"}`, run.ok ? "success" : "error");
      resource.reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setRunning(null);
    }
  }

  const busy = running !== null;
  return (
    <div className="space-y-1.5 pt-2 border-t border-gray-200 dark:border-gray-700" data-testid="plugin-sync-panel">
      <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Sync</div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void trigger("pull", false)} data-testid="plugin-sync-pull">
          {running === "pull" ? "Pulling…" : "Pull now"}
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void trigger("push", false)} data-testid="plugin-sync-push">
          {running === "push" ? "Pushing…" : "Push now"}
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void trigger("pull", true)} data-testid="plugin-sync-dry-pull">
          Dry run (pull)
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void trigger("push", true)} data-testid="plugin-sync-dry-push">
          Dry run (push)
        </button>
      </div>
      {!status ? (
        <div className="text-[11px] text-gray-400">Loading sync status…</div>
      ) : (
        <div className="space-y-1">
          {!status.configured && (
            <div className="text-xs text-amber-700 dark:text-amber-400">Sync is not fully configured (settings or credentials missing).</div>
          )}
          <RunLine label="pull" run={status.lastRuns.pull} />
          <RunLine label="push" run={status.lastRuns.push} />
          <div className="text-xs text-gray-500" data-testid="plugin-sync-outbox">
            Outbox: {status.outboxLength === null ? "unknown" : `${status.outboxLength} queued`}
          </div>
          <div className="text-xs text-gray-500" data-testid="plugin-sync-schedule">
            Schedule: pull {scheduleLabel(status.schedule.pullEveryMinutes)}, push {scheduleLabel(status.schedule.pushEveryMinutes)}
          </div>
        </div>
      )}
    </div>
  );
}
