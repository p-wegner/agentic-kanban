import type { Database } from "../db/index.js";
import { narrowProviderName } from "../services/agent-provider.js";
// #774 — the fleet shape behind a `no_available_worker` skip, so the reason is not a
// single collapsed token. Same computation `GET /api/workers` serves.
import { describeFleet } from "../services/placement-explain.service.js";
import type { MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";

/**
 * What the fleet looked like when a project's start was held for `no_available_worker`
 * (#774, remaining #755 item 6).
 *
 * Before this, the whole answer was the token `no_available_worker` in `reasonCounts` plus
 * a `[monitor]` console line — so an operator reading the monitor status could not tell
 * "nobody paired a worker" from "every slot is busy" from "the one worker's socket dropped",
 * and the three have completely different remedies. The console line was the only place the
 * resolver's own `reason` appeared, and console output is not part of any status payload.
 *
 * NOTE: nothing READS this yet. The two consumers — `monitor-setup.ts` (which assembles the
 * status payload from `runAutoStart`'s return) and `autodrive-stall-warning.service.ts` —
 * were not #774's files. Tracked as **#801**.
 */
export interface FleetHoldDetail {
  /** The resolver's own refusal wording, verbatim. */
  reason: string;
  registered: number;
  online: number;
  /** Online AND holding a live WebSocket — the pair that actually makes a worker pickable. */
  connected: number;
  eligible: number;
  freeSlots: number;
  /** Where to get the full ordered decision chain for a specific ticket. */
  explain: string;
}

/**
 * What the machine looked like when a project's start was held for `machine_saturated`
 * (#908). Mirrors `FleetHoldDetail`'s reasoning: the collapsed skip-reason token alone
 * cannot tell an operator "Tier 1 measured true thrashing" from "Tier 0's cheap freemem
 * floor tripped because Tier 1 was unavailable", and those have different remedies (wait
 * out the real load, vs. install/reach `fleet` for a sharper answer).
 */
export interface MachineSaturationDetail {
  /** Which tier answered: "1" when the `fleet` tool was reachable, "0" otherwise. */
  tier: "0" | "1";
  /** The capacity read's own wording. */
  reason: string;
  freeGb?: number | null;
  headroomProcesses?: number;
  thrashing?: string;
}

/**
 * The slice of the auto-start cycle a hold recorder needs: the connection to read the fleet
 * through, the prefs it reads the provider from, the cycle's machine-capacity snapshot, and
 * the two tally sinks. Taking this instead of the whole `AutoStartCycle` is what keeps the
 * dependency one-way — `monitor-auto-start` imports this module, never the reverse.
 *
 * `database` is INJECTED rather than read off the `db` singleton so this module stays out of
 * `startup/`'s persistence-boundary backlog (#715) — that baseline may only shrink, and the
 * one read here (`describeFleet`) already takes a `Database`, so there was nothing to grandfather.
 */
export interface StartHoldContext {
  database: Database;
  prefMap: Map<string, string>;
  machineCapacity: MachineCapacitySnapshot;
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: "no_available_worker" | "machine_saturated", count?: number) => void;
  attachFleetHold: (projectId: string, detail: FleetHoldDetail) => void;
  attachMachineSaturation: (projectId: string, detail: MachineSaturationDetail) => void;
}

/**
 * Record a strict-fleet hold, WITH the shape of the fleet behind it (#774). Best-effort:
 * a hold must still be recorded (and the cycle must still skip the project) if the fleet
 * snapshot itself fails.
 */
export async function recordFleetHold(ctx: StartHoldContext, projectId: string, dispatchReason: string): Promise<void> {
  let fleetHold: FleetHoldDetail | undefined;
  try {
    const snapshot = await describeFleet({
      database: ctx.database,
      projectId,
      providerName: narrowProviderName(ctx.prefMap.get("provider")),
    });
    fleetHold = {
      reason: dispatchReason,
      registered: snapshot.registered,
      online: snapshot.online,
      connected: snapshot.connected,
      eligible: snapshot.eligible,
      freeSlots: snapshot.freeSlots,
      explain: `/api/workers/explain?projectId=${projectId}&issue=<N>`,
    };
  } catch (err) {
    console.warn(`[monitor] could not describe the fleet behind the hold: ${String(err)}`);
  }
  console.log(
    `[monitor] auto-start held for project ${projectId}: ${dispatchReason}` +
      (fleetHold
        ? ` (${fleetHold.connected}/${fleetHold.registered} connected, ${fleetHold.eligible} eligible, ` +
          `${fleetHold.freeSlots} free slots; why for one ticket: ${fleetHold.explain})`
        : ""),
  );
  ctx.noteSkip(projectId, null, "no_available_worker");
  if (fleetHold) ctx.attachFleetHold(projectId, fleetHold);
}

/**
 * Record a `machine_saturated` hold, WITH the capacity read behind it (#908) — same
 * reasoning as `recordFleetHold`: the collapsed token in `reasonCounts` cannot carry the
 * measured numbers an operator would need to judge "is this real load or a stale floor",
 * so the shape travels alongside it.
 */
export function recordMachineSaturationHold(ctx: StartHoldContext, projectId: string): void {
  const capacity = ctx.machineCapacity;
  const detail: MachineSaturationDetail =
    capacity.tier === "1"
      ? {
          tier: "1",
          reason: `${capacity.headroomProcesses} headroom process(es), thrashing=${capacity.thrashing}`,
          headroomProcesses: capacity.headroomProcesses,
          thrashing: capacity.thrashing,
        }
      : { tier: "0", reason: capacity.reason, freeGb: capacity.freeGb };
  console.log(
    `[monitor] auto-start held for project ${projectId}: host is saturated (tier ${detail.tier}: ${detail.reason}) ` +
      `and no eligible worker can take the overflow`,
  );
  ctx.noteSkip(projectId, null, "machine_saturated");
  ctx.attachMachineSaturation(projectId, detail);
}
