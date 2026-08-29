// The board host as a CANDIDATE in the placement ranking (#938).
//
// #910 made worker selection headroom-aware — free RAM, spare cores, a thrashing flag,
// highest headroom first — and left the board host outside that comparison entirely. The
// host participated only through a binary `hostSaturated` flag, which changed which
// `PlacementReason` got recorded (`machine_saturated` vs `eligible_worker`) and never
// ranked anything. So a board with 40GB free handed work to a worker with 1GB free, purely
// because the project had opted into dispatch: the ranking was applied to every machine in
// the fleet except the one the board runs on.
//
// This module is the shape that was missing — "host as a WorkerCandidate" — kept beside
// `worker-fleet.service.ts` rather than inside it because it is its own concept with its
// own rules (no slot ledger, no socket, no label filter) and because the fleet service is
// at its cohesion ceiling.
import type { WorkerCapacityInfo } from "@agentic-kanban/shared/lib/worker-protocol";

/**
 * One machine that could take this launch — a registered worker, or (since #938) the board
 * host itself. Ranked by {@link compareCandidates}.
 */
export type WorkerCandidate = {
  id: string;
  load: number;
  cap: number;
  /** #910: this machine's last reported headroom. Undefined = unknown (an older build). */
  capacity?: WorkerCapacityInfo;
  /**
   * #938: this candidate IS the board host, not a registered worker. `id` is
   * {@link HOST_CANDIDATE_ID}, which is not a worker id and must never be handed to the
   * connection manager or to `reserveWorkerSlot` — the host has no slot ledger and no
   * socket. Callers that can only act on a worker never build it; the ones that want the
   * comparison check this flag on the winner.
   */
  isHost?: true;
};

/**
 * The board host's id in a ranked candidate list.
 *
 * Deliberately not a uuid: it must be impossible for a registered worker to collide with
 * it, and it should be obvious in a log line that this is the board itself rather than a
 * worker whose name happens to be "host".
 */
export const HOST_CANDIDATE_ID = "__board_host__";

/**
 * Rank two candidates by headroom, then load (#910).
 *
 * `--max-concurrency` is a self-declared slot count — a 4-core and a 64-core worker are
 * indistinguishable by `cap`/`load` alone, so a machine that REPORTS its actual free RAM
 * sorts ahead of one that doesn't, all else equal. A machine with no capacity report
 * (absent = unknown, an older build) is treated exactly as before that field existed:
 * neither preferred nor penalised by headroom, so it falls straight through to the load
 * tiebreak. THRASHING DEPRIORITISES, IT DOES NOT EXCLUDE — a thrashing machine still sorts
 * behind every calm candidate but ahead of nothing being available at all, which is the
 * difference between "avoid if there's a choice" and "refuse".
 *
 * The host is ranked by these same rules and gets no special treatment in either direction
 * (#938): that is the whole point of making it a candidate instead of a boolean.
 */
export function compareCandidates(a: WorkerCandidate, b: WorkerCandidate): number {
  const aThrashing = a.capacity?.thrashing === "heavy" || a.capacity?.thrashing === "light";
  const bThrashing = b.capacity?.thrashing === "heavy" || b.capacity?.thrashing === "light";
  if (aThrashing !== bThrashing) return aThrashing ? 1 : -1;
  const aHeadroom = a.capacity?.freeRamGb;
  const bHeadroom = b.capacity?.freeRamGb;
  if (aHeadroom !== undefined && bHeadroom !== undefined && aHeadroom !== bHeadroom) {
    return bHeadroom - aHeadroom; // higher headroom first
  }
  if (aHeadroom !== undefined && bHeadroom === undefined) return -1;
  if (aHeadroom === undefined && bHeadroom !== undefined) return 1;
  return a.load - b.load;
}

/**
 * The board host as a candidate in the SAME ranked list as the workers (#938).
 *
 * **The capacity read is the caller's, not ours.** Tier 1 spawns `fleet snapshot`, which
 * would put a process spawn inside a selection that must not `await` between its load read
 * and its reservation (#751), and inside the monitor's per-project loop. The caller already
 * reads capacity for its own reasons (`session-lifecycle.ts` reads Tier 0 per launch) and
 * simply passes what it has, folded through `toWorkerCapacitySnapshot` — the same conversion
 * the worker daemon uses for its own heartbeat, so both sides are measured the same way.
 *
 * **No capacity ⇒ no candidate.** An unmeasured host cannot be ranked, and defaulting it to
 * "unknown headroom" would rank it ahead of nothing and behind every reporting worker,
 * which is a claim the board never made. Returning `null` reproduces pre-#938 behaviour
 * exactly.
 *
 * `cap`/`load` are 1/0 — the host is one candidate with one notional slot, and nothing
 * reserves against it. This is the headroom comparison it exists for, not slot accounting.
 */
export function hostCandidate(capacity: WorkerCapacityInfo | undefined): WorkerCandidate | null {
  if (!capacity) return null;
  return { id: HOST_CANDIDATE_ID, load: 0, cap: 1, capacity, isHost: true };
}

/** How a candidate's headroom reads in a recorded reason — the numbers that decided. */
export function describeHeadroom(capacity: WorkerCapacityInfo | undefined): string {
  if (!capacity) return "";
  return ` (${capacity.freeRamGb.toFixed(1)}GB free${
    capacity.thrashing !== "none" ? `, thrashing=${capacity.thrashing}` : ""
  })`;
}
