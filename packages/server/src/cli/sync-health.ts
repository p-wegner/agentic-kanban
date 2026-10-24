import type { PluginSyncHealth, PluginSyncRunRecord } from "../services/plugin-sync.service.js";
import type { ConsoleAttention } from "./status-console-model.js";

// #1673: sync health for `status --watch` and ATTENTION. Pure - built from the run summaries the
// board already stores (#1625) and the plugin's local registers; no Jira calls, no clock.

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const DAY_MS = 24 * 3600 * 1000;
const PANEL = "Settings > Plugins";

function runPart(label: string, run: PluginSyncRunRecord | null, nowMs: number): string {
  if (!run) return `${label} never`;
  const age = formatAge(nowMs - Date.parse(run.finishedAt || run.startedAt));
  return `${label} ${age} ago ${run.ok ? "ok" : "FAILED"}${run.dryRun ? " (dry)" : ""}`;
}

/** Minutes until the next scheduled run of whichever direction is due first; null when no schedule is set. */
function nextRun(h: PluginSyncHealth, nowMs: number): string {
  const due: number[] = [];
  for (const [dir, every] of [["pull", h.status.schedule.pullEveryMinutes], ["push", h.status.schedule.pushEveryMinutes]] as const) {
    if (every <= 0) continue;
    const last = h.status.lastRuns[dir];
    due.push(last && !last.dryRun ? Date.parse(last.startedAt) + every * 60_000 : nowMs);
  }
  if (due.length === 0) return "no schedule";
  const wait = Math.min(...due) - nowMs;
  return wait <= 0 ? "next run due" : `next in ${formatAge(wait)}`;
}

export function syncHealthLines(health: PluginSyncHealth[], nowMs: number): Array<{ level: "red" | "yellow" | "ok"; text: string }> {
  return health.map((h) => {
    const { lastRuns } = h.status;
    const conflicts = h.conflicts?.count ?? 0;
    const failures = h.failures?.count ?? 0;
    const failed = [lastRuns.pull, lastRuns.push].some((r) => r && !r.dryRun && !r.ok);
    const text = [
      `${h.projectName ? `${h.projectName} / ` : ""}${h.pluginName}: ${runPart("pull", lastRuns.pull, nowMs)}, ${runPart("push", lastRuns.push, nowMs)}`,
      `${h.conflicts ? conflicts : "?"} conflicts${h.conflicts?.needsHuman ? ` (${h.conflicts.needsHuman} needs-human)` : ""}${conflicts > 0 && h.conflictsDriven === false ? " (no ticket)" : ""}`,
      `${h.failures ? failures : "?"} failed pushes`,
      `outbox ${h.status.outboxLength ?? "?"}`,
      nextRun(h, nowMs),
    ].join(" · ");
    return { level: failed ? "red" : conflicts + failures > 0 ? "yellow" : "ok", text };
  });
}

export function syncHealthAttention(health: PluginSyncHealth[], nowMs: number): ConsoleAttention[] {
  const out: ConsoleAttention[] = [];
  for (const h of health) {
    const where = `${h.projectName ? `${h.projectName} / ` : ""}${h.pluginName} (${PANEL} > ${h.pluginName})`;
    for (const dir of ["pull", "push"] as const) {
      const run = h.status.lastRuns[dir];
      const every = dir === "pull" ? h.status.schedule.pullEveryMinutes : h.status.schedule.pushEveryMinutes;
      if (run && !run.dryRun && !run.ok && run.scheduled) {
        out.push({ level: "red", text: `${where}: scheduled ${dir} failed ${formatAge(nowMs - Date.parse(run.finishedAt || run.startedAt))} ago${run.error ? `: ${run.error.split("\n")[0]!.slice(0, 100)}` : ""}` });
      }
      if (every > 0 && h.status.configured) {
        const real = run && !run.dryRun ? Date.parse(run.startedAt) : null;
        if (real != null && nowMs - real > 3 * every * 60_000) {
          out.push({ level: "yellow", text: `${where}: no ${dir} for ${formatAge(nowMs - real)} (every ${every} min)` });
        }
      }
    }
    if (h.conflicts && h.conflicts.count > 0 && h.conflictsDriven === false) {
      // #1697: nothing is working the conflict, so it waits for an operator or the next loop advance; say so now.
      out.push({ level: "yellow", text: `${where}: ${h.conflicts.count} open conflict(s) with no open loop ticket${h.conflicts.needsHuman ? ` (${h.conflicts.needsHuman} needs-human)` : ""}` });
    } else if (h.conflicts && h.conflicts.count > 0 && h.conflicts.oldestAt && nowMs - Date.parse(h.conflicts.oldestAt) > DAY_MS) {
      out.push({ level: "yellow", text: `${where}: ${h.conflicts.count} open conflict(s), oldest ${formatAge(nowMs - Date.parse(h.conflicts.oldestAt))}` });
    }
  }
  return out;
}
