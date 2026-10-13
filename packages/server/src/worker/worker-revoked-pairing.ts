// A saved pairing the board no longer accepts (#1450).
//
// The first live run of the connect runbook (#1442) found a machine still holding state for a
// worker that had been revoked on the board minutes earlier. `setup` saw "already paired" and
// skipped pairing; `start` then ran under an identity every request answers 401 to. When the
// operator supplied a fresh pairing token, the stale identity is the thing in the way: keep a copy
// aside (never delete: it is the only record of which worker this was), drop it from the state file
// and let the normal pairing path register again. Db-free: part of the standalone worker binary.

import { copyFileSync } from "node:fs";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { findIdentity, forgetIdentity, loadState, normalizeBoardUrl } from "./worker-state.js";

export type PairingVerdict = "none" | "valid" | "revoked" | "unreachable";

/** Ask the board whether the saved identity for `boardUrls` still authenticates (a bare heartbeat, as doctor does). */
export async function probeSavedPairing(
  stateFile: string,
  boardUrls: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ verdict: PairingVerdict; workerId?: string; url?: string }> {
  const state = loadState(stateFile);
  let unreachable = false;
  for (const url of boardUrls) {
    const identity = findIdentity(state, url);
    if (!identity?.workerId || !identity.workerToken) continue;
    try {
      const res = await fetchImpl(`${normalizeBoardUrl(url)}/api/workers/${identity.workerId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${identity.workerToken}` },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) return { verdict: "revoked", workerId: identity.workerId, url };
      return { verdict: "valid", workerId: identity.workerId, url };
    } catch {
      unreachable = true;
    }
  }
  return { verdict: unreachable ? "unreachable" : "none" };
}

/**
 * If the saved pairing is rejected as revoked, copy the state file to `<state>.revoked-<ms>` and
 * forget the identity so pairing runs afresh. Says so through `log`. Returns the copy's path, or
 * null when nothing was done (no pairing, still valid, or the board could not be asked).
 */
export async function moveAsideRevokedPairing(opts: {
  stateFile: string;
  boardUrls: string[];
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<string | null> {
  const probe = await probeSavedPairing(opts.stateFile, opts.boardUrls, opts.fetchImpl);
  if (probe.verdict !== "revoked") return null;
  const aside = `${opts.stateFile}.revoked-${opts.nowMs ?? Date.now()}`;
  try {
    copyFileSync(opts.stateFile, aside);
  } catch (err) {
    opts.log(`[worker] the board rejected the saved pairing (worker ${probe.workerId}) but a copy could not be kept (${errorMessage(err)}); leaving it in place`);
    return null;
  }
  forgetIdentity(opts.stateFile, probe.url!);
  opts.log(`[worker] the board rejected the saved pairing (worker ${probe.workerId} was revoked); moved it aside to ${aside} and pairing again with the new token`);
  return aside;
}
