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
 * True when this project's HOST builder starts should be held THIS cycle. Both checks are
 * process-local and free (no spawn), so they run before the preference read — an idle board
 * never pays for either. A gate that is running but the host is NOT saturated holds nothing:
 * the whole point of #909 is that "a gate is in flight" and "the box is tight" are different
 * facts, and only the second earns a hold on projects that have nothing to do with this gate.
 *
 * **#936 — "host" in that first sentence is load-bearing.** This answers a question about the
 * BOX, so it can only ever justify holding a start that would run ON the box. The caller must
 * treat it as a PLACEMENT input the way `isHostSaturated` already is (#908): a project whose
 * fleet can absorb the work has somewhere else to run it, and skipping its cycle outright is
 * what let one project's multi-hour gate freeze ten unrelated monitor-mode projects for hours.
 */
export async function shouldQuiesceBuildersForGate(projectId: string, database: Database): Promise<boolean> {
  if (!buildGateBusy()) return false;
  if (!readTier0Capacity().hold) return false;
  return quiesceBuildersEnabled(projectId, database);
}

/** What a monitor cycle should do about a running gate (#936). */
export type GateQuiesceAction =
  /** Nothing is contended, or this project can route around it — keep pulling work. */
  | { action: "proceed"; reason: "no_host_hold" | "fleet_overflow" }
  /** The host is held and this project has nowhere else to run — skip, visibly. */
  | { action: "skip"; reason: "verify_gate_running" };

/**
 * DECISION (pure): does a running verify gate stop THIS project's cycle (#936)?
 *
 * Split out of `runTodoPull` so the rule is checkable without an entire monitor-cycle
 * fixture, and because it is exactly the "decision function" kind this package documents:
 * a synchronous verdict co-located with the executor that acts on it.
 *
 * The rule that matters: a gate hold is a statement about the BOX, so it can only hold a
 * start that would run on the box. Before this, the caller returned unconditionally — and
 * with a merge costing multiple hours of gate time, ten monitor-mode projects were skipped
 * with `verify_gate_running` every cycle for hours. They were not queued behind the gate;
 * they were skipped and never run, so one project's backlog froze the whole board.
 */
export function decideGateQuiesce(input: {
  /** {@link shouldQuiesceBuildersForGate} — is the host held for this project? */
  hostHeld: boolean;
  /** Can this project's fleet absorb a start the host cannot take? */
  fleetOverflowAvailable: boolean;
}): GateQuiesceAction {
  if (!input.hostHeld) return { action: "proceed", reason: "no_host_hold" };
  if (input.fleetOverflowAvailable) return { action: "proceed", reason: "fleet_overflow" };
  return { action: "skip", reason: "verify_gate_running" };
}

/**
 * The monitor's whole gate-contention question, answered in one call (#936): read the host
 * hold, ask about fleet overflow only if the host IS held (an idle board must not pay for a
 * fleet lookup), and say out loud when a project routes around a running gate rather than
 * being skipped by it.
 */
export async function resolveGateQuiesce(args: {
  projectId: string;
  database: Database;
  hasFleetOverflowCapacity: () => Promise<boolean>;
}): Promise<GateQuiesceAction> {
  const hostHeld = await shouldQuiesceBuildersForGate(args.projectId, args.database);
  const decision = decideGateQuiesce({
    hostHeld,
    fleetOverflowAvailable: hostHeld ? await args.hasFleetOverflowCapacity() : false,
  });
  if (decision.reason === "fleet_overflow") {
    console.log(
      `[monitor] Verify gate is running and the host is tight, but project ${args.projectId} has fleet `
        + `overflow capacity — pulling work anyway rather than skipping the cycle (#936).`,
    );
  }
  return decision;
}
