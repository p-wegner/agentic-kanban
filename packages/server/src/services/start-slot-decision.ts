import type { MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";

/**
 * How many tickets may this project start RIGHT NOW (#1102)?
 *
 * The arithmetic used to live twice, inline, in the monitor's two auto-start loops — the
 * In-Progress backfill (`startup/monitor-auto-start.ts`) and the Todo pull
 * (`startup/monitor-todo-pull.ts`): the WIP ceiling, the #1019 headroom clamp, the #908
 * saturated-host-unless-the-fleet-absorbs-it hold, and the per-cycle start cap. A third copy
 * was about to appear in `GET /api/projects/:id/autopilot`, the read behind the toolbar's
 * Autopilot chip, and a chip that computes "+2 next cycle" with its own copy would drift from
 * what the monitor then does. So there is one function, and all three call it.
 *
 * DECISION (pure): numbers and a snapshot in, a verdict out — no I/O, no clock. The caller does
 * the async reads (capacity, active WIP, the fleet-overflow question) and passes their answers.
 */

/**
 * #1019: the WIP clamp a caller computed for this cycle, passed into the hold recorder so
 * the measured capacity numbers and the resulting limit travel together.
 */
export interface WipHeadroomClamp {
  /** The project's configured WIP target, before capacity was consulted. */
  configured: number;
  /** What the cycle will actually run at. */
  effective: number;
  /** True when capacity actually lowered the target (`effective < configured`). */
  clamped: boolean;
}

/**
 * DECISION (pure): what WIP may this cycle actually run at, given the box (#1019)?
 *
 * The host-saturation check is BINARY — it answers "is the host full", and the loops act on it
 * by skipping the project outright. Between "fine" and "full" there is a graded signal the
 * snapshot already carried and nothing consumed: Tier 1's `headroomProcesses`, how many more
 * whole agent processes the box can take. Without this, a project configured at WIP 5 on a box
 * with room for one more agent starts four it cannot hold, and the resulting gate run loses to
 * fork timeouts (#1006/#994 — 780 of 783 tests lost that way) and reads as RED rather than as
 * "the machine was oversubscribed".
 *
 * The clamp is `currentWip + headroom`, never the bare headroom: `headroomProcesses` counts
 * ADDITIONAL processes, so the agents already running are not in it, and clamping the LIMIT to
 * a delta would read as "stop 3 of the 4 running builders" instead of "start no more". It only
 * ever LOWERS the configured target — a roomy box can never raise it above what the operator asked.
 *
 * Tier 0 has no headroom measurement at all (one `os.freemem()` read against a floor), so it
 * returns the target unchanged and leaves the binary hold to do its job: reporting a fabricated
 * clamp from a tier that did not measure it is exactly the "presenting a Tier-0 guess as the
 * sharper Tier-1 measurement" failure #908 wrote down.
 *
 * (Moved here from `startup/monitor-start-holds.ts` by #1102, which re-exports it, so a service
 * can reach it without importing `startup/`.)
 */
export function clampWipToHeadroom(input: {
  /** The project's configured WIP target (`resolveWipLimit`). */
  wipLimit: number;
  /** How many workspaces are active for this project right now. */
  currentWip: number;
  capacity: MachineCapacitySnapshot;
}): WipHeadroomClamp {
  const unclamped: WipHeadroomClamp = { configured: input.wipLimit, effective: input.wipLimit, clamped: false };
  if (input.capacity.tier !== "1") return unclamped;
  const effective = Math.min(input.wipLimit, input.currentWip + Math.max(0, input.capacity.headroomProcesses));
  if (effective >= input.wipLimit) return unclamped;
  return { configured: input.wipLimit, effective, clamped: true };
}

/** Why no new ticket may start — the first rule that holds wins, in this order. */
export type StartSlotHoldReason =
  /** The project is not auto-started at all (Start Mode is not `monitor`). */
  | "manual_mode"
  /** Active WIP already reaches the configured limit. */
  | "wip_full"
  /** The host is saturated with nowhere to overflow, or the headroom clamp leaves no room. */
  | "machine_full"
  /** This cycle already launched its `maxNewStartsPerCycle`. */
  | "start_cap";

export interface StartSlotInput {
  /** The configured WIP limit (`resolveWipLimit(...).limit`). */
  wipLimit: number;
  /** Active WIP right now (`countWipCapacity(...).active`). */
  active: number;
  /** The cycle's one machine-capacity read (#908). */
  machineCapacity: MachineCapacitySnapshot;
  maxNewStartsPerCycle: number;
  /** Starts this project already made THIS cycle (counted across both loops). */
  startedThisCycle: number;
  /**
   * Can this project's fleet absorb a start a saturated host cannot take? Only meaningful when
   * the host is saturated; callers ask the (async, DB-reading) question only in that case and
   * pass `false` otherwise — exactly as the loops always did.
   */
  fleetOverflow: boolean;
  /** Whether this project is auto-started at all. Absent = yes (the monitor loops only run for such projects). */
  autoStart?: boolean;
}

export interface StartSlotDecision {
  /** Tickets that may start now: `min(wipSlots, startsRemaining)`, 0 when held. */
  slots: number;
  /**
   * Free WIP slots under the effective limit, IGNORING the per-cycle start cap — 0 only when a
   * WIP/machine/mode hold applies. The pull loop bounds its iteration by this and checks the
   * start cap per candidate, which is what records `cycle_start_cap` on each held ticket.
   */
  wipSlots: number;
  startsRemaining: number;
  /** The limit the cycle runs at after the #1019 headroom clamp. */
  effectiveLimit: number;
  clamp: WipHeadroomClamp;
  /** Saturated AND no fleet overflow — the #908 binary hold. */
  hostFull: boolean;
  holdReason: StartSlotHoldReason | null;
}

export function decideStartSlots(input: StartSlotInput): StartSlotDecision {
  const clamp = clampWipToHeadroom({ wipLimit: input.wipLimit, currentWip: input.active, capacity: input.machineCapacity });
  // `hold` is the snapshot's own normalized verdict — see `isHostSaturated` for why it is not
  // re-derived from `headroomProcesses` here.
  const hostFull = input.machineCapacity.hold && !input.fleetOverflow;
  const startsRemaining = Math.max(0, input.maxNewStartsPerCycle - input.startedThisCycle);

  let holdReason: StartSlotHoldReason | null = null;
  if (input.autoStart === false) holdReason = "manual_mode";
  else if (input.active >= input.wipLimit) holdReason = "wip_full";
  else if (hostFull || input.active >= clamp.effective) holdReason = "machine_full";
  else if (startsRemaining <= 0) holdReason = "start_cap";

  const wipSlots = holdReason === null || holdReason === "start_cap" ? Math.max(0, clamp.effective - input.active) : 0;
  const slots = holdReason === null ? Math.min(wipSlots, startsRemaining) : 0;
  return { slots, wipSlots, startsRemaining, effectiveLimit: clamp.effective, clamp, hostFull, holdReason };
}
