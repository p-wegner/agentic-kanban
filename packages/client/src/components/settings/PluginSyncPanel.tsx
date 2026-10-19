import { useState } from "react";
import type { PluginSyncRunRecord, PluginSyncStatusView } from "@agentic-kanban/shared";
import { apiPost } from "../../lib/api.js";
import { useApiResource } from "../../hooks/useApiResource.js";
import { showToast } from "../../lib/toast.js";

type Props = { pluginRowId: string; projectId: string };

const BUTTON_CLASS =
  "text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50";

/** The scheduler ticks once a minute and a run is due only when a full interval has elapsed since the last START. */
const SCHEDULER_TICK_MINUTES = 1;

/**
 * Effective cadence (#1630): a 1-minute setting fired about every 2 minutes, because the tick that
 * lands just under a full interval after the previous start skips and the next one runs. So the
 * real cadence is the setting plus one tick; show that and when the next run lands.
 */
export function effectiveCadence(minutes: number, lastRun: PluginSyncRunRecord | null): { label: string; nextAt: string | null } {
  if (minutes <= 0) return { label: "off", nextAt: null };
  const effective = minutes + SCHEDULER_TICK_MINUTES;
  const startedMs = lastRun && !lastRun.dryRun ? Date.parse(lastRun.startedAt) : NaN;
  return {
    label: `every ~${effective} min (set ${minutes})`,
    nextAt: Number.isFinite(startedMs) ? new Date(startedMs + effective * 60_000).toLocaleString("en-US") : null,
  };
}

/** Fold a just-finished run into the status so the panel shows it before the reload lands. */
export function applyTriggeredRun(status: PluginSyncStatusView, run: PluginSyncRunRecord): PluginSyncStatusView {
  const current = status.lastRuns[run.direction];
  // Server data at least as new as the folded run wins (e.g. a scheduled run landed meanwhile).
  if (current && Date.parse(current.finishedAt) >= Date.parse(run.finishedAt)) return status;
  return { ...status, lastRun: run, lastRuns: { ...status.lastRuns, [run.direction]: run } };
}

type RunIssue = { externalKey: string; localIssueNumber?: number };

function BoardIssueLink({ number }: { number: number | undefined }) {
  if (number === undefined) return null;
  return (
    <>
      {" "}
      <a href={`?issue=${number}`} className="underline" data-testid={`plugin-sync-board-issue-${number}`}>#{number}</a>
    </>
  );
}

function localNumber(row: RunIssue, issues: RunIssue[] | undefined): number | undefined {
  return row.localIssueNumber ?? issues?.find((i) => i.externalKey === row.externalKey)?.localIssueNumber;
}

export function RunLine({ label, run }: { label: string; run: PluginSyncRunRecord | null }) {
  if (!run) {
    return <div className="text-xs text-gray-500" data-testid={`plugin-sync-run-${label}`}>{label}: no run yet</div>;
  }
  const counts = run.summary?.counts ?? {};
  const countText = Object.entries(counts)
    .filter(([, n]) => typeof n === "number")
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  const dryNote = run.dryRun && countText ? ", nothing sent" : "";
  return (
    <div className="text-xs space-y-0.5" data-testid={`plugin-sync-run-${label}`}>
      <div className={run.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
        <span className="font-medium">{label}</span>
        {run.dryRun ? " (dry run)" : ""}
        {run.scheduled ? " (scheduled)" : ""}: {run.ok ? "ok" : "failed"}
        <span className="text-gray-500"> at {new Date(run.finishedAt).toLocaleString("en-US")}</span>
        {countText ? <span className="text-gray-600 dark:text-gray-300"> - {`${run.dryRun ? "dry run: " : ""}${countText}${dryNote}`}</span> : null}
      </div>
      {run.error && <div className="text-red-700 dark:text-red-400 whitespace-pre-wrap break-words">{run.error}</div>}
      {(run.summary?.conflicts ?? []).map((c) => (
        <div key={`c-${c.externalKey}`} className="pl-3 text-amber-700 dark:text-amber-400">
          conflict{" "}
          {c.externalUrl ? <a href={c.externalUrl} target="_blank" rel="noreferrer" className="underline">{c.externalKey}</a> : c.externalKey}
          <BoardIssueLink number={localNumber(c, run.summary?.issues)} />
          : {c.reason}
        </div>
      ))}
      {(run.summary?.failures ?? []).map((f, i) => (
        <div key={`f-${f.externalKey}-${i}`} className="pl-3 text-red-700 dark:text-red-400">
          failed{" "}
          {f.externalUrl ? <a href={f.externalUrl} target="_blank" rel="noreferrer" className="underline">{f.externalKey}</a> : f.externalKey}
          <BoardIssueLink number={localNumber(f, run.summary?.issues)} />
          : {f.reason}
        </div>
      ))}
    </div>
  );
}

export function SyncStatusBody({ status }: { status: PluginSyncStatusView }) {
  const pull = effectiveCadence(status.schedule.pullEveryMinutes, status.lastRuns.pull);
  const push = effectiveCadence(status.schedule.pushEveryMinutes, status.lastRuns.push);
  return (
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
        Schedule: pull {pull.label}{pull.nextAt ? `, next at ${pull.nextAt}` : ""}; push {push.label}{push.nextAt ? `, next at ${push.nextAt}` : ""}
      </div>
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
  const [triggered, setTriggered] = useState<PluginSyncRunRecord | null>(null);
  const status = resource.data && triggered ? applyTriggeredRun(resource.data, triggered) : resource.data;
  const [running, setRunning] = useState<string | null>(null);

  async function trigger(direction: "pull" | "push", dryRun: boolean) {
    const id = `${direction}${dryRun ? "-dry" : ""}`;
    setRunning(id);
    try {
      const run = await apiPost<PluginSyncRunRecord>(`/api/plugins/${pluginRowId}/sync/trigger`, { projectId, direction, dryRun });
      setTriggered(run);
      showToast(run.ok ? `${direction}${dryRun ? " dry run" : ""} finished` : `${direction} failed: ${run.error ?? "see the sync panel"}`, run.ok ? "success" : "error");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setRunning(null);
      // Refetch after the run ends (success or failure): the server status is the source of truth,
      // the locally folded run only bridges the gap until it lands.
      resource.reload();
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
      {busy && <div className="text-xs text-blue-700 dark:text-blue-400" data-testid="plugin-sync-running">Running {running?.replace("-dry", " (dry run)")}…</div>}
      {!status ? (
        <div className="text-[11px] text-gray-400">Loading sync status…</div>
      ) : (
        <SyncStatusBody status={status} />
      )}
    </div>
  );
}
