/**
 * Builder quiescing during a verify gate (#581), now HOST-SATURATION-SCOPED (#909).
 *
 * Measured live: raising `verify_max_workers` 2 -> 6 (#536) cut this repo's server suite
 * from 2380s to 1564s wall — a real 34% win — and the FIRST gate that ran at 6 workers
 * while two builders were also working failed three `mergeWorkspace` cases that pass
 * everywhere else. Those are slow real-git tests; under load the merge flow never reaches
 * cleanup and an assertion that is really a timing assertion fails. The output named a
 * real test and a plausible defect ("post-merge cleanup did not run"), so it took a
 * 55-minute gate run plus two isolated re-runs to classify as a flake.
 *
 * The original fix: while a gate holds the build-concurrency semaphore, the monitor does
 * not START new builders. That held EVERY project's starts for the gate's WHOLE duration —
 * measured: one 44-minute gate froze auto-start for 13 unrelated projects the entire time,
 * on an otherwise idle box that had room for all of them. `buildGateBusy()` answers "is a
 * gate running", never "is the box actually tight right now" — those are different
 * questions, and only the second one justifies holding OTHER projects' starts.
 *
 * #909 narrows the hold to Tier 0/1 saturation (`readTier0Capacity`, the same signal
 * `monitor-auto-start.ts`'s `machine_saturated` skip and `session-lifecycle.ts`'s placement
 * decision already use): a gate running on a box with room does not hold anything, and
 * remote placement is untouched either way — this only ever governs HOST starts.
 */
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { readTier0Capacity } from "@agentic-kanban/shared/lib/machine-capacity";
import { buildGateBusy } from "./jvm-build-semaphore.js";

const quiescePrefDef = projectPref("quiesce_builders_during_gate");

export function quiesceBuildersDuringGatePrefKey(projectId: string): string {
  return quiescePrefDef.key(projectId);
}

/** Default ON: a trustworthy gate result is worth one cycle of start latency. */
export async function quiesceBuildersEnabled(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(quiesceBuildersDuringGatePrefKey(projectId), database).catch(() => null);
  return raw?.trim().toLowerCase() !== "false";
}

/**
 * True when this project's builder starts should be held THIS cycle. Both checks are
 * process-local and free (no spawn), so they run before the preference read — an idle board
 * never pays for either. A gate that is running but the host is NOT saturated holds nothing:
 * the whole point of #909 is that "a gate is in flight" and "the box is tight" are different
 * facts, and only the second earns a hold on projects that have nothing to do with this gate.
 */
export async function shouldQuiesceBuildersForGate(projectId: string, database: Database): Promise<boolean> {
  if (!buildGateBusy()) return false;
  if (!readTier0Capacity().hold) return false;
  return quiesceBuildersEnabled(projectId, database);
}
