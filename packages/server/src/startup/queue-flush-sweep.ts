/**
 * The flush tick (#1463, decision 020 parts 3-4): once per interval, for every project,
 *  - evaluate the auto trigger when `queue_flush_<id>=auto` (thresholds -> the same path a manual
 *    click takes, rails included), and
 *  - advance every non-terminal flush record one verdict (`flushed -> sweeping -> red/healed ->
 *    healing -> healed -> merged-back`), since a post-flush sweep is minutes to an hour and
 *    nothing else is waiting on it.
 *
 * `service` is injected: the caller builds it over the merge queue (needs the session manager).
 */
import type { Database } from "../db/index.js";
import { getProjectIdsWithRepoPath } from "../repositories/project.repository.js";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import type { QueueFlushService } from "../services/queue-flush.service.js";

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export interface QueueFlushSweepResult extends PassReport {
  fired: string[];
  advanced: Array<{ projectId: string; flushId: string; state: string }>;
}

export async function reconcileQueueFlush(
  opts: { database: Database; service: Pick<QueueFlushService, "evaluateAuto" | "reconcileHeal">; log?: (message: string) => void; now?: string },
): Promise<QueueFlushSweepResult> {
  const log = opts.log ?? ((message: string) => console.log(`[queue-flush] ${message}`));
  const projects = await getProjectIdsWithRepoPath(opts.database);
  const result: QueueFlushSweepResult = { ...emptyPassReport(projects.length), fired: [], advanced: [] };
  for (const project of projects) {
    try {
      const auto = await opts.service.evaluateAuto(project.id, { now: opts.now });
      if (auto.fired) {
        result.fired.push(project.id);
        log(`project ${project.id}: auto flush started (${auto.reason})`);
      }
      const moved = await opts.service.reconcileHeal(project.id, { now: opts.now });
      for (const rec of moved) {
        result.advanced.push({ projectId: project.id, flushId: rec.id, state: rec.state });
        log(`project ${project.id}: flush ${rec.id} -> ${rec.state}`);
      }
      if (auto.fired || moved.length > 0) recordActed(result, project.id, auto.fired ? "auto flush" : "heal advanced");
      else recordSkipped(result, project.id, "nothing to do");
    } catch (err) {
      recordSkipped(result, project.id, `error: ${err instanceof Error ? err.message : String(err)}`);
      log(`project ${project.id}: tick failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startQueueFlushSweep(opts: { database: Database; service: Pick<QueueFlushService, "evaluateAuto" | "reconcileHeal">; intervalMs?: number }): void {
  stopQueueFlushSweep();
  sweep = startPeriodicSweep({
    name: "queue-flush",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileQueueFlush({ database: opts.database, service: opts.service }),
  });
}

export function stopQueueFlushSweep(): void {
  sweep?.stop();
  sweep = null;
}
