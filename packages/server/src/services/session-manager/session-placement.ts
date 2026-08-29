// WHERE a launch runs, and the record of why (#938 extracted this from
// `session-lifecycle.ts`, which was at the god-module gate's 1000-line ceiling).
//
// One cohesive job: turn a workspace about to launch into a `Placement`, translate the
// resolver's strict-mode refusal into the `WorkspaceError` shape callers already handle,
// and stamp the deciding reason onto the session row. `startSession` keeps the launch; this
// keeps the placement.
import type { Database } from "../../db/index.js";
import type { Placement } from "../agent-dispatch.service.js";
import type { ProviderName } from "../agent-provider.js";
import { resolveWorkerPlacement, WorkerDispatchUnavailableError } from "../worker-fleet.service.js";
import { updateSessionPlacementReason } from "../../repositories/placement-observability.repository.js";
import { readTier0Capacity, toWorkerCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { WorkspaceError } from "../workspace-internals.js";

/**
 * #801 — the recording seam for "why did THAT session run on the host".
 *
 * `resolveWorkerPlacement` stamps its deciding check onto the placement it returns; this is
 * where that becomes durable. A live re-derivation can never answer the historical question,
 * because the preferences, the fleet and the repo shape have all moved since.
 *
 * Written only for a RESOLVED placement: an explicit `placement` argument was never
 * resolved, so it carries no reasoning, and stamping a fabricated one would destroy the
 * distinction the nullable column exists to keep. Best-effort and un-awaited, exactly like
 * the containerId write — an observability record must never be able to fail a launch.
 */
export function recordPlacementReason(
  sessionId: string,
  placement: Placement | undefined,
  database: Database,
): void {
  const reason = placement?.reason;
  if (!reason) return;
  updateSessionPlacementReason(sessionId, reason, database).catch((err) =>
    console.error(`[session] Failed to store session placement reason: sessionId=${sessionId}`, err),
  );
}

/**
 * Resolve where this launch runs, and record why (epic #1, #184, #801, #908, #938).
 *
 * A project opted into worker dispatch gets an eligible remote worker, else the host.
 * Strict worker dispatch refuses the host fallback: surfaced as a CONFLICT the caller can
 * act on — the same shape devcontainer strict mode uses for `ISOLATION_REFUSED` — rather
 * than silently running on the board.
 */
export async function resolveSessionPlacement(args: {
  database: Database;
  sessionId: string;
  projectId: string;
  providerName: ProviderName;
  /** A direct workspace has no feature branch to push back, so it has no git transport. */
  branch?: string;
  baseBranch?: string;
  /** #750: set only when this launch actually resumes a provider session. */
  resumeProviderSessionId?: string;
}): Promise<Placement> {
  const { database, sessionId, projectId, providerName, branch, baseBranch, resumeProviderSessionId } = args;
  // #908/#938: ONE Tier-0 read feeding BOTH placement inputs — reading it twice would let
  // them disagree about the same instant. Tier 0 is one in-process `os.freemem()` call,
  // cheap enough per launch (Tier 1 spawns a process and is the monitor's per-cycle read).
  const hostTier0 = readTier0Capacity();
  const placement = await resolveWorkerPlacement({
    database,
    projectId,
    providerName,
    branch,
    baseBranch,
    resumeProviderSessionId,
    // #908: a saturated host does NOT block this launch — that would turn a placement input
    // into a gate. It only changes which reason lands on the session record when the chain
    // picks a worker anyway (`machine_saturated` rather than `eligible_worker`).
    hostSaturated: hostTier0.hold,
    // #938: the same reading in the shape a worker heartbeats, so the board is RANKED
    // against the fleet instead of only fallen back to. Tier 0 is RAM-only, so its
    // `thrashing: "none"` is honestly "not measured" — the host can only win on free RAM it
    // actually reported, never on a thrashing tiebreak it has not earned.
    hostCapacity: toWorkerCapacitySnapshot(hostTier0),
  }).catch((err) => {
    if (err instanceof WorkerDispatchUnavailableError) {
      throw new WorkspaceError(err.message, "CONFLICT", { code: "NO_AVAILABLE_WORKER" });
    }
    throw err;
  });
  recordPlacementReason(sessionId, placement, database);
  return placement;
}
