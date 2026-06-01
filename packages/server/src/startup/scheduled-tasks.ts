import { db } from "../db/index.js";
import { scheduledRunHistory, scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { getNextCronRun } from "@agentic-kanban/shared/lib/cron-utils";
import { randomUUID } from "node:crypto";

export function setupScheduledTasks(serverPort: number): void {
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

  // Check every minute
  setInterval(() => { runScheduledRunsCycle().catch(() => {}); }, 60 * 1000);
  // Initial check after 10s (let server fully start)
  setTimeout(() => { runScheduledRunsCycle().catch(() => {}); }, 10 * 1000);
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
