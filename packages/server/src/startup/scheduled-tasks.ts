import { db } from "../db/index.js";
import { projects, scheduledRunHistory, scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { getNextCronRun } from "@agentic-kanban/shared/lib/cron-utils";
import { randomUUID } from "node:crypto";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { conductorAvailable, runConductorCycleOnce } from "../services/conductor-control.service.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { conductorCronPrefKey, runDueConductorCrons } from "../services/conductor-schedule.service.js";

export interface ScheduledTaskTimers {
  timer: ReturnType<typeof setTimeout>;
  interval: ReturnType<typeof setInterval>;
}

let activeScheduledTaskTimers: ScheduledTaskTimers | null = null;

export function stopScheduledTasks(): void {
  if (activeScheduledTaskTimers) {
    clearTimeout(activeScheduledTaskTimers.timer);
    clearInterval(activeScheduledTaskTimers.interval);
    activeScheduledTaskTimers = null;
  }
}

export function setupScheduledTasks(serverPort: number): ScheduledTaskTimers {
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
            const res = await fetch(`http://127.0.0.1:${serverPort}/api/scheduled-runs/${run.id}/run?triggeredBy=scheduler`, { method: "POST" });
            if (!res.ok) {
              const body = await res.text();
              const reason = `Launch error: ${res.status} ${body}`;
              console.warn(`[scheduler] run "${run.name}" failed: ${reason}`);
            }
          } catch (err) {
            console.warn(`[scheduler] run "${run.name}" error:`, err);
            await recordSchedulerFailure(run, `Launch error: ${err instanceof Error ? err.message : String(err)}`);
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

async function recordSchedulerFailure(run: typeof scheduledRuns.$inferSelect, reason: string) {
  const now = new Date().toISOString();
  try {
    await db.insert(scheduledRunHistory).values({
      id: randomUUID(),
      scheduledRunId: run.id,
      projectId: run.projectId,
      status: "error",
      reason,
      triggeredBy: "scheduler",
      issueId: run.systemIssueId,
      workspaceId: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
    });
    await db.update(scheduledRuns).set({
      lastRunAt: now,
      lastRunStatus: "error",
      lastRunWorkspaceId: null,
      updatedAt: now,
    }).where(eq(scheduledRuns.id, run.id));
  } catch (err) {
    console.warn("[scheduler] failed to record scheduled run failure:", err);
  }
}
