/**
 * Monitor step for the compounding "setup once" pass (#127).
 *
 * Runs BETWEEN tickets — in the monitor cycle, alongside auto-contract/auto-start — never
 * per ticket. That placement is the whole design: the pass is expensive-ish and only pays
 * off once, so it belongs in the board's periodic loop rather than in every builder's
 * cold start (which is exactly the cost it exists to remove).
 *
 * Ordering: BEFORE `runAutoStart`, so a builder launched this cycle already forks from the
 * branch the pass just committed to. A pass that ran after the fan-out would first benefit
 * the cycle after next.
 */

import { projectStatuses } from "@agentic-kanban/shared/schema";
import { sql } from "drizzle-orm";
import { getNumber } from "@agentic-kanban/shared/lib/settings-registry";
import { db } from "../db/index.js";
import {
  DEFAULT_MIN_MERGES,
  maybeRunCompoundingSetup,
  resolveCompoundingSetupGate,
} from "../services/compounding-setup.service.js";

export interface CompoundingSetupStepDeps {
  /** Which projects this cycle may act on (same predicate the rest of the cycle uses). */
  allowProject: (projectId: string) => boolean;
  database?: typeof db;
}

/**
 * Run the pass for every allowed project that is due. Returns the number of projects set up
 * this cycle (0 on a steady-state board, which is the normal case — it is a once-per-project
 * event). Best-effort: a failure on one project is logged and never aborts the monitor cycle.
 */
export async function runCompoundingSetup(
  prefMap: Map<string, string>,
  { allowProject, database = db }: CompoundingSetupStepDeps,
): Promise<number> {
  const defaultThreshold = getNumber(prefMap, "compounding_setup_min_merges", DEFAULT_MIN_MERGES);

  // Projects with statuses = projects that actually exist on this board.
  const rows = await database
    .selectDistinct({ projectId: projectStatuses.projectId })
    .from(projectStatuses)
    .where(sql`${projectStatuses.projectId} IS NOT NULL`);

  let setUp = 0;
  for (const { projectId } of rows) {
    if (!projectId || !allowProject(projectId)) continue;

    const gate = resolveCompoundingSetupGate(prefMap, projectId, defaultThreshold);
    if (!gate.enabled) continue;

    try {
      const result = await maybeRunCompoundingSetup(projectId, gate, database);
      if (!result.ran) continue;
      setUp++;
      console.log(
        `[monitor] compounding setup pass ran for project ${projectId} ` +
        `(${result.mergedCount} merged workspaces >= threshold ${gate.threshold}); ` +
        `artifacts: ${result.artifacts.join(", ") || "none"}`,
      );
    } catch (err) {
      console.warn(
        `[monitor] compounding setup pass failed for project ${projectId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return setUp;
}
