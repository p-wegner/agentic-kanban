// Pure formatting helpers split out of worker.ts (#1605); re-exported there.
import type { SessionPlacementRecord } from "../../lib/placement-explain.types.js";

/**
 * `worker list` talks to an OWNER route (`GET /api/workers`), mounted only on the board's
 * loopback app - never on the fleet listener a remote worker's `--board` points at (#848).
 * A 404 there is not "board unreachable" (that would be a fetch rejection, never a response
 * at all): it means this URL answered, just not with that route, which is exactly what
 * happens when `--board` was pointed at the fleet port instead of the board's API port.
 * Any OTHER non-OK status (5xx, etc.) keeps the original "is the board running" framing,
 * since those genuinely can indicate a struggling-but-reachable board.
 */
export function describeWorkerListFailure(status: number, boardUrl: string): string {
  if (status === 404) {
    return (
      `Failed to list workers (404). '${boardUrl}' answered, but 'GET /api/workers' is an owner route ` +
      "reachable only from the board's own machine (loopback) - never from the fleet port a remote " +
      "worker's --board points at. Run 'worker list' on the board machine instead, against its API " +
      "port (default http://127.0.0.1:3001)."
    );
  }
  return `Failed to list workers (${status}). Is the board running at ${boardUrl}?`;
}

/**
 * `[completed]` alone hides a worker-lost run (#1319): the board finalizes it completed / exit 1
 * and an operator reading the list must not mistake it for a success.
 */
/** `fetch 4.2s | setup 61s | agent 8m12s ...` - recorded phases only, in pipeline order (#1328). */
export function formatPhaseTimings(phases: NonNullable<SessionPlacementRecord["phases"]>): string {
  const fmt = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  const parts: Array<[string, number | undefined]> = [
    [phases.fetchKind ?? "fetch", phases.fetchMs],
    ["worktree", phases.worktreeMs],
    ["setup", phases.setupMs],
    ["agent", phases.agentMs],
    ["push", phases.pushMs],
    ["land", phases.landMs],
  ];
  return parts
    .filter((p): p is [string, number] => p[1] !== undefined)
    .map(([label, ms]) => `${label} ${fmt(ms)}`)
    .join(" | ");
}

export function formatPlacementState(p: Pick<SessionPlacementRecord, "status" | "exitCode" | "endedBy">): string {
  if (!p.endedBy) return `[${p.status}]`;
  const why = p.endedBy === "abandoned" ? "worker abandoned" : "worker lost";
  return `[${p.status}, exit ${p.exitCode ?? "?"}, ${why}]`;
}
