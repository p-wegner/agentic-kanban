/**
 * "Is this OS process still alive?" — ONE answer, because the EPERM half of it was the
 * disagreement (#545).
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the process exists and
 * whether we may signal it. It therefore has THREE outcomes, not two, and the third is the
 * one four hand-rolled copies split on:
 *
 *   - resolves            → the process exists.
 *   - throws ESRCH        → no such process.
 *   - throws **EPERM**    → the process EXISTS but belongs to another user / is protected.
 *
 * EPERM is `alive`. Reading it as dead is not a style preference, it is a false negative
 * about a running agent: `startup-tasks` did exactly that and marked an EPERM-protected live
 * agent "stopped" on every single restart, resetting its workspace out from under a process
 * that was still working (#574). `zombie-fix-session-reconciler` had the same polarity and
 * would have recovered a session whose agent was still running.
 *
 * This probes a RAW pid, which is only meaningful for a host process. Liveness of a session
 * running in a container or on a remote worker is the dispatch proxy's question — ask
 * `sessionManager.isProcessAlive(sessionId)` where a session id is at hand.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
