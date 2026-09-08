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
import { probeTempHealth } from "@agentic-kanban/shared/lib/temp-health";
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

// --- holding the gate ITSELF on a saturated host (#1057) --------------------------------------

const hostFloorPrefDef = projectPref("gate_host_floor");

export function gateHostFloorPrefKey(projectId: string): string {
  return hostFloorPrefDef.key(projectId);
}

/** Default ON: a doomed 28-minute run is worse than a deferred merge. */
export async function gateHostFloorEnabled(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(gateHostFloorPrefKey(projectId), database).catch(() => null);
  return raw?.trim().toLowerCase() !== "false";
}

/** Whether a verify chain may START right now, and why not when it may not. */
export type GateHostAdmission =
  | { admit: true; reason: "host_has_room" | "floor_disabled" }
  | { admit: false; reason: "host_saturated" | "temp_exhausted"; detail: string };

/**
 * DECISION (pure): may a pre-merge gate START its verify chain on this box? (#1057)
 *
 * This file already holds builder starts while a gate runs, so the gate is protected FROM
 * builders — but nothing ever asked the reverse question, and that asymmetry is what this
 * closes. The base-health probe has consulted the same signal since #1009
 * (`isBaseHealthProbeDue({ hostSaturated })`), so the SWEEP declines to measure a base it
 * cannot measure while the GATE, running the very same verify script, would start regardless.
 *
 * MEASURED, 2026-09-07: three independent branches (#1046, #1048, #1049) each ran a full gate
 * on a box at 100% CPU that was swapping 2334 pages/s, and each failed in a DIFFERENT test
 * batch after ~28 minutes — 85 minutes of wall clock that proved nothing about any of the three
 * diffs. Not one of the three failures could even be attributed, because the verify log
 * truncates before the failing suite (#1049 — itself one of the three that could not land).
 * This file's own header already describes that exact shape from #581: "a 55-minute gate run
 * plus two isolated re-runs to classify as a flake".
 *
 * A hold is NOT a red gate. It is the cheap, honest "not now" — the merge is withheld and
 * retried on the next cycle, and #638 already guarantees a withheld gate never becomes an
 * ungated merge and never reaches the fix agent. What it must never do is silently pass: a
 * gate that did not run cannot approve a merge.
 *
 * Fail-open by construction, exactly like #1009: an unreadable capacity yields `hold: false`
 * from `readTier0Capacity`, so a box whose memory cannot be sampled behaves as it does today.
 */
export function decideGateHostAdmission(input: {
  /** {@link readTier0Capacity} — is the box too tight to add work right now? */
  capacityHold: boolean;
  /** The measured reason, for the message. */
  capacityReason: string;
  /** `gate_host_floor_<projectId>` — false lets an operator run the gate anyway. */
  floorEnabled: boolean;
  /**
   * {@link probeTempHealth} — is `%TEMP%` too big or too slow to run a verify chain on? (#1056)
   *
   * A SECOND way the same box can be unfit, and one CPU and memory cannot see: the three
   * #1046/#1048/#1049 failures this file's header attributes to saturation were measured
   * again on an IDLE box (CPU 18 %, 4.9 GB usable) and failed identically, which is what
   * refuted the load reading. The `%TEMP%` the runner writes into held 707,242 entries.
   *
   * Optional so an older caller that does not probe behaves exactly as it does today.
   */
  tempDegraded?: boolean;
  /** The measured reason, for the message. */
  tempReason?: string;
}): GateHostAdmission {
  if (!input.floorEnabled) return { admit: true, reason: "floor_disabled" };
  if (input.capacityHold) return { admit: false, reason: "host_saturated", detail: input.capacityReason };
  // Capacity first: it is the cheaper signal and the more common cause. A box that is BOTH
  // saturated and temp-exhausted is reported as saturated, which is the one an operator can
  // act on immediately.
  if (input.tempDegraded) {
    return {
      admit: false,
      reason: "temp_exhausted",
      detail:
        (input.tempReason ?? "%TEMP% is unusable")
        + " — drain it with `node scripts/sweep-loose-test-db-files.mjs` and the merge retries "
        + "on the next cycle",
    };
  }
  return { admit: true, reason: "host_has_room" };
}

/**
 * The gate's admission question in one call: read capacity first (process-local and free, no
 * spawn), and only pay for the preference read when the box is actually tight — an idle board
 * never touches the database for this.
 */
export async function resolveGateHostAdmission(args: {
  projectId: string;
  database: Database;
  /** Injected for tests; defaults to the live Tier-0 read. */
  readCapacity?: () => { hold: boolean; reason: string };
  /** Injected for tests; defaults to the live bounded `%TEMP%` probe (#1056). */
  readTempHealth?: () => { degraded: boolean; reason: string };
}): Promise<GateHostAdmission> {
  const capacity = (args.readCapacity ?? readTier0Capacity)();
  // The temp probe is bounded (at most `DEFAULT_TEMP_PROBE_BUDGET_MS`) but it is not free like
  // the capacity read, so skip it entirely when capacity has already decided the answer.
  const temp = capacity.hold
    ? { degraded: false, reason: "" }
    : (args.readTempHealth ?? probeTempHealth)();
  const anyHold = capacity.hold || temp.degraded;
  return decideGateHostAdmission({
    capacityHold: capacity.hold,
    capacityReason: capacity.reason,
    floorEnabled: anyHold ? await gateHostFloorEnabled(args.projectId, args.database) : true,
    tempDegraded: temp.degraded,
    tempReason: temp.reason,
  });
}
