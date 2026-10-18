// Keep fleet workers on the promoted build (#1610).
//
// After a promote the board runs a new worker build while a worker can sit on the old one for
// days (desktop-stable/wsl-stable kept a15f90a and were still handed train gates). Two halves:
//   - `isWorkerBuildStale`: the placement filter — a worker on a different build gets no verify chains.
//   - `startWorkerAutoUpdate`: a background sweep that asks each ONLINE stale worker to update the
//     moment it is idle (no builder session, no verify job), logging one line per worker.
import { compareWorkerBuild } from "@agentic-kanban/shared/lib/worker-build-freshness";
import { resolveBoardCommit, resolveOwnPackageVersion } from "../lib/worker-build.js";
import { resolveBoardWorkerBuild } from "../lib/worker-bundle.js";
import type { Database } from "../db/index.js";
import { listActiveVerifyJobs } from "./verify-active-jobs.js";
import { getWorkerFleet } from "./worker-fleet.service.js";

/** Does this worker run a different worker build than the board? Unknown on either side = not stale. */
export function isWorkerBuildStale(workerVersion: string | undefined | null): boolean {
  const boardBuild = resolveBoardWorkerBuild(undefined, resolveBoardCommit);
  return compareWorkerBuild(workerVersion, resolveOwnPackageVersion(), boardBuild) === "different-build";
}

export interface AutoUpdateWorkerView {
  id: string;
  name: string;
  effectiveStatus?: string;
  workerVersion?: string;
  updateRequested?: boolean;
  update?: { state?: string };
  assignments?: unknown[];
  load?: number;
}

export type AutoUpdateDecision = { workerId: string; workerName: string; action: "update" | "wait"; reason: string };

/** Pure: which online, stale workers should be asked to update now, and which must wait. */
export function decideWorkerUpdates(
  workers: AutoUpdateWorkerView[],
  isStale: (workerVersion: string | undefined) => boolean,
  activeVerifyWorkerIds: ReadonlySet<string>,
): AutoUpdateDecision[] {
  const out: AutoUpdateDecision[] = [];
  for (const w of workers) {
    if (w.effectiveStatus !== "online" || !isStale(w.workerVersion)) continue;
    if (w.updateRequested || w.update?.state === "updating") continue;
    const busy = (w.assignments?.length ?? w.load ?? 0) > 0 || activeVerifyWorkerIds.has(w.id);
    out.push({
      workerId: w.id,
      workerName: w.name,
      action: busy ? "wait" : "update",
      reason: busy ? "busy; will update when idle" : "idle; update requested",
    });
  }
  return out;
}

/** One pass; returns the lines logged. Never throws. */
export async function runWorkerAutoUpdatePass(database: Database, log: (line: string) => void = (l) => console.log(l)): Promise<AutoUpdateDecision[]> {
  try {
    const { registry } = getWorkerFleet(database);
    const views = (await registry.listWorkersView()) as unknown as AutoUpdateWorkerView[];
    const activeVerify = new Set(listActiveVerifyJobs().map((j) => j.workerId));
    const decisions = decideWorkerUpdates(views, isWorkerBuildStale, activeVerify);
    for (const d of decisions) {
      if (d.action === "update") await registry.requestUpdate(d.workerId);
      log(`[worker-auto-update] ${d.workerName}: build is behind the board, ${d.reason}`);
    }
    return decisions;
  } catch (err) {
    console.warn(`[worker-auto-update] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Workers still waiting are re-logged each pass; keep the cadence slow enough to stay quiet. */
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

export function startWorkerAutoUpdate(database: Database, intervalMs = DEFAULT_INTERVAL_MS): void {
  stopWorkerAutoUpdate();
  timer = setInterval(() => void runWorkerAutoUpdatePass(database), intervalMs);
  timer.unref?.();
}

export function stopWorkerAutoUpdate(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
