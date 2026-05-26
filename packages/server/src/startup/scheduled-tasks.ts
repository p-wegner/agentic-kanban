import { db } from "../db/index.js";
import { scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { getNextCronRun } from "@agentic-kanban/shared/lib/cron-utils";

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
            const res = await fetch(`http://localhost:${serverPort}/api/scheduled-runs/${run.id}/run`, { method: "POST" });
            if (!res.ok) {
              const body = await res.text();
              console.warn(`[scheduler] run "${run.name}" failed: ${res.status} ${body}`);
            }
          } catch (err) {
            console.warn(`[scheduler] run "${run.name}" error:`, err);
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
