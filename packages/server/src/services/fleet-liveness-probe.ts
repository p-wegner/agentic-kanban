// The LIVE wiring of the remote-session liveness rule (#744, cycle fix).
//
// `remote-session-liveness.ts` is deliberately fleet-free: it decides
// alive/dead/unknown from evidence handed to it. This module is the one place that
// obtains the evidence from the worker-fleet facade, which cannot be imported by the
// rule itself — the facade constructs the remote agent service, which needs the rule's
// abandon bound, and dependency-cruiser counts a dynamic import as an edge just like a
// static one. So the accessor is injected here instead of imported there.
//
// Callers (the boot re-adoption pass and the two reconcilers) import
// `probeRemoteSessionLiveness` from HERE.

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { probeRemoteSessionLivenessWith, type LivenessVerdict } from "./remote-session-liveness.js";
import { getWorkerFleet } from "./worker-fleet.service.js";

/** Liveness of a session on a fleet worker, read from the live fleet. Never throws. */
export async function probeRemoteSessionLiveness(
  row: { workerId: string; startedAt?: string | null },
  database: Database = realDb,
  opts: { nowMs?: number; abandonAfterMs?: number } = {},
): Promise<LivenessVerdict> {
  const isWorkerConnected = (workerId: string): boolean => {
    try {
      return getWorkerFleet(database).connections.isConnected(workerId);
    } catch (err) {
      // No fleet in this process (or it failed to build): "not connected" is the
      // honest reading, and it produces `unknown` -> HOLD rather than a false death.
      console.error(`[liveness] could not reach the worker fleet for ${workerId}`, err);
      return false;
    }
  };
  return probeRemoteSessionLivenessWith(isWorkerConnected, row, database, opts);
}
