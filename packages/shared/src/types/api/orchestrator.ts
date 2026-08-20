/**
 * Conductor/orchestrator status (#569). The client's copy in `hooks/useOrchestrator.ts`
 * carried a comment saying "Mirrors OrchestratorStatus in
 * packages/server/src/services/orchestrator-monitor.service.ts" — a hand-maintained
 * mirror announcing itself as one.
 */
export interface OrchestratorStatus {
  available: boolean;
  /** Driver considered alive iff loop.log was written within ALIVE_STALENESS_MS. */
  alive: boolean;
  pid: number | null;
  /** ISO timestamp loop.log was last written (freshness / "last activity"). */
  lastLogAt: string | null;
  /** ISO timestamp of the most recent iteration boundary seen in loop.log. */
  lastEventAt: string | null;
  /** Current/last iteration number. */
  iteration: number | null;
  /** "running" if the last boundary was a START with no matching END, else "idle". */
  phase: "running" | "idle" | "unknown";
  /** Exit code of the last completed iteration (124 = hit the 30-min cap). */
  lastExit: number | null;
  /** Duration in seconds of the last completed iteration. */
  lastDurationSec: number | null;
  /** Most recent cycle-summary lines from state.md (newest last), comments stripped. */
  recentCycles: string[];
}
