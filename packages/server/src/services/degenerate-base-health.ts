import type { DegenerateBaseHealthWarning } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getAllProjects } from "../repositories/project.repository.js";
import { countBaseBranchHealthOutcomes } from "../repositories/base-branch-health.repository.js";

export type { DegenerateBaseHealthWarning };

/**
 * Probes required before "never green" becomes a claim rather than a coincidence (#681).
 *
 * Every consumer of base-branch health reads only the LATEST row, where "the base is red
 * again" and "this probe cannot produce a green" are indistinguishable. The distribution is
 * what separates them, and it only separates them once there are enough samples: a base that
 * is genuinely broken for an afternoon legitimately shows 10 reds in a row.
 *
 * 20 is deliberately well below the measured case (200 probes, 199 red + 1 timeout, 0 green,
 * five days, roughly half of all base-health verdicts in the DB false) and well above a bad
 * afternoon. A false alarm here costs one line in the monitor's warning list; the silence it
 * replaces cost five days of gates blaming innocent branches.
 */
export const DEGENERATE_BASE_HEALTH_MIN_PROBES = 20;

/**
 * The decision, as a pure function of the counts — so the threshold and the wording are
 * testable without a DB, and so "what makes a distribution degenerate" is stated in one place.
 *
 * `unverified` rows are excluded from the total: they record that the probe could not run at
 * all (no verify_script, missing clone), which is a different fact and not evidence about the
 * base. Counting them would let a project with 50 unverified rows and one red trip this.
 */
export function isDegenerateBaseHealth(counts: {
  byOutcome: { green: number; red: number; timeout: number; unverified: number };
}): { degenerate: boolean; conclusiveProbes: number } {
  const { green, red, timeout } = counts.byOutcome;
  const conclusiveProbes = green + red + timeout;
  return {
    degenerate: conclusiveProbes >= DEGENERATE_BASE_HEALTH_MIN_PROBES && green === 0,
    conclusiveProbes,
  };
}

/**
 * Alarm on a base-health probe that has NEVER produced a green (#681).
 *
 * The gap this closes: no check asked "has this probe ever been green?". A probe wired wrong
 * (the #674 case — the clone was never installed, so every verdict was an install artifact:
 * `TS2688 Cannot find type definition file for 'node'`, `Could not resolve 'vite'`) answers
 * red forever, and the answer is USED — the gate attributes a branch failure to a red base, or
 * withholds a merge on one. Wrong-and-loud is worse than absent, and it ran unremarked for
 * five days because nothing looked at the shape of the answers.
 */
export async function scanDegenerateBaseHealth(database: Database = db): Promise<DegenerateBaseHealthWarning[]> {
  const projects = await getAllProjects(database);
  const detectedAt = new Date().toISOString();
  const warnings: DegenerateBaseHealthWarning[] = [];

  for (const project of projects) {
    const counts = await countBaseBranchHealthOutcomes(project.id, database).catch(() => null);
    if (!counts) continue;
    const { degenerate, conclusiveProbes } = isDegenerateBaseHealth(counts);
    if (!degenerate) continue;
    const { green, red, timeout } = counts.byOutcome;
    const window = counts.firstAt && counts.lastAt
      ? ` between ${counts.firstAt} and ${counts.lastAt}`
      : "";
    warnings.push({
      type: "degenerate_base_health",
      projectId: project.id,
      projectName: project.name,
      detectedAt,
      probeCount: conclusiveProbes,
      greenCount: green,
      redCount: red,
      timeoutCount: timeout,
      firstProbeAt: counts.firstAt,
      lastProbeAt: counts.lastAt,
      message:
        `base-branch health for "${project.name}" has NEVER been green: ${conclusiveProbes} probe(s)` +
        `${window} — ${red} red, ${timeout} timeout, 0 green. A probe that cannot produce a green is ` +
        `not measuring the base; its verdicts are being used to blame branches and withhold merges. ` +
        `Check the probe itself (install/clone step, verify_script, timeout) before trusting any red it reports.`,
    });
  }
  return warnings;
}
