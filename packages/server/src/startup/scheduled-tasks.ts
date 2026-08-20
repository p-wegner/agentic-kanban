import { db } from "../db/index.js";
import { projects, scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { getNextCronRun } from "@agentic-kanban/shared/lib/cron-utils";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { conductorAvailable, runConductorCycleOnce } from "../services/conductor-control.service.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { conductorCronPrefKey, runDueConductorCrons } from "../services/conductor-schedule.service.js";

export interface ScheduledTaskTimers {
  timer: ReturnType<typeof setTimeout>;
  interval: ReturnType<typeof setInterval>;
}

/**
 * Dependency-injected trigger for a due scheduled run (#402). This used to be a
 * self-HTTP `fetch` to `POST /api/scheduled-runs/:id/run` on the server's own
 * port — the documented anti-pattern (packages/server/CLAUDE.md): a runtime
 * dependency on port availability, types erased by the JSON round trip, and
 * untestable without a listening server. The wiring in
 * `startup/background-services.ts` passes the SAME service function the route
 * handler calls (`createScheduledRunService(...).run`), so behaviour is
 * identical minus the loopback hop.
 */
export interface ScheduledTasksDeps {
  runScheduledRun: (
    id: string,
    triggeredBy: string,
  ) => Promise<{ workspaceId?: string; skipped?: boolean; reason?: string }>;
}

let activeScheduledTaskTimers: ScheduledTaskTimers | null = null;

export function stopScheduledTasks(): void {
  if (activeScheduledTaskTimers) {
    clearTimeout(activeScheduledTaskTimers.timer);
    clearInterval(activeScheduledTaskTimers.interval);
    activeScheduledTaskTimers = null;
  }
}

export function setupScheduledTasks(deps: ScheduledTasksDeps): ScheduledTaskTimers {
  stopScheduledTasks();

  async function runScheduledRunsCycle() {
    try {
      const now = new Date();
      const enabled = await db.select().from(scheduledRuns).where(eq(scheduledRuns.enabled, true));
      for (const run of enabled) {
        const lastRun = run.lastRunAt ? new Date(run.lastRunAt) : null;
        let nextRun: Date;
        if (run.cronExpression) {
          const base = lastRun ?? new Date(now.getTime() - 60_000);
          const next = getNextCronRun(run.cronExpression, base);
          if (!next) continue;
          nextRun = next;
        } else {
          nextRun = lastRun
            ? new Date(lastRun.getTime() + run.intervalMinutes * 60 * 1000)
            : now; // first run immediately
        }
        if (now >= nextRun) {
          console.log(`[scheduler] triggering scheduled run "${run.name}" (${run.id})`);
          try {
            const result = await deps.runScheduledRun(run.id, "scheduler");
            if (result?.skipped) {
              console.log(`[scheduler] run "${run.name}" skipped: ${result.reason ?? "unknown"}`);
            }
          } catch (err) {
            // The scheduled-run service records its own failure history/lastRun state
            // on launch and config errors (fail()/catch paths in scheduled-run.service),
            // so recording again here would double-book — just log.
            console.warn(`[scheduler] run "${run.name}" failed:`, err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] cycle error:", err);
    }
  }

  // Fire one off-process Conductor cycle for every project whose cron schedule is due
  // (ticket #841). Independent of the scheduled_runs table above — this drives the
  // out-of-process board-monitor loop on a cron instead of running it continuously.
  async function runConductorCronCycle() {
    try {
      const fired = await runDueConductorCrons({
        listProjects: async () => {
          const rows = await db.select({ id: projects.id, repoPath: projects.repoPath }).from(projects);
          return rows
            .filter((r) => !!r.repoPath)
            .map((r) => ({ projectId: r.id, repoPath: r.repoPath }));
        },
        getSchedulePref: (projectId) => getPreference(conductorCronPrefKey(projectId), db),
        setSchedulePref: (projectId, value) => setPreference(conductorCronPrefKey(projectId), value, db),
        fire: (repoPath, agent) => runConductorCycleOnce(repoPath, agent),
        isAvailable: (repoPath) => conductorAvailable(repoPath),
        isAlive: (repoPath) => readOrchestratorStatus(repoPath).alive,
      });
      for (const r of fired) {
        if (r.fired) console.log(`[scheduler] fired Conductor cron cycle for project ${r.projectId} (pid ${r.pid ?? "?"})`);
        else if (r.skipped === "fire_failed") console.warn(`[scheduler] Conductor cron fire failed for project ${r.projectId}: ${r.error ?? "unknown"}`);
      }
    } catch (err) {
      console.error("[scheduler] conductor cron cycle error:", err);
    }
  }

  // Check every minute
  const interval = setInterval(() => {
    runScheduledRunsCycle().catch(() => {});
    runConductorCronCycle().catch(() => {});
  }, 60 * 1000);
  // Initial check after 10s (let server fully start)
  const timer = setTimeout(() => {
    runScheduledRunsCycle().catch(() => {});
    runConductorCronCycle().catch(() => {});
  }, 10 * 1000);

  const handles: ScheduledTaskTimers = { timer, interval };
  activeScheduledTaskTimers = handles;
  return handles;
}
