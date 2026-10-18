// Drain report + shutdown/reconnect result handling split out of worker-daemon.ts (#1605); re-exported there.
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import type { createWorkerAgentRunner, UnpushedResult } from "./worker-agent-runner.js";

/**
 * What a shutdown managed to save, and what it did not (#754). Returned rather than
 * logged-and-forgotten because "nothing was lost" and "one push was abandoned" are the
 * two outcomes an operator needs told apart.
 */
export interface DrainReport {
  /** Result pushes that completed during the drain. */
  pushesCompleted: number;
  /** Sessions still pushing when the drain timed out â€” their work stayed on the worker. */
  pushesAbandoned: number;
  /** #1461: which sessions/branches those were; each is persisted to the undelivered-results store. */
  abandonedSessions?: { sessionId: string; branch: string }[];
  /** Agents still running at exit (only possible with killAgents: false). */
  agentsLeftRunning: number;
  /**
   * Critical messages (exit/assign_failed) that could not be delivered. The queue is
   * in-memory and capped at PENDING_QUEUE_CAP, so anything still here at exit is LOST:
   * a drain can flush the queue to a live socket, but it cannot persist it.
   */
  criticalMessagesLost: number;
  /**
   * Finished results still held on this machine because every push attempt failed (#750).
   * Their checkouts are KEPT â€” the daemon logs each path â€” so they are recoverable by
   * hand, but the in-memory retry list itself does not survive this process.
   */
  resultsRetained: number;
}

/**
 * #750: a result whose push failed while the board was unreachable can only be saved by an
 * attempt made after it is back â€” this is that attempt, run on every (re)connect. The push
 * lands in the incoming namespace, where the #752 operator surface can land it.
 */
export function retryRetainedResults(
  runner: ReturnType<typeof createWorkerAgentRunner>,
  sendToBoard: (message: WorkerToBoardMessage) => void,
  log: (line: string) => void,
): void {
  void runner.retryPendingPushes().then((outcome) => {
    if (outcome.pushed.length > 0) {
      log(`[worker] pushed ${outcome.pushed.length} retained result(s) after reconnecting`);
    }
    for (const retained of runner.unpushedResults()) {
      log(
        `[worker] still holding an unpushed result: sessionId=${retained.sessionId} ` +
          `checkout=${retained.checkoutPath} branch=${retained.localBranch} ` +
          `attempts=${retained.attempts} lastError=${retained.lastError}`,
      );
      // #871: a result whose reconnect retry ALSO failed is reported to the board, which is the
      // one place an operator actually looks. Through sendToBoard so a socket that died again
      // queues it as critical rather than dropping it.
      sendToBoard({
        type: "undelivered_result",
        sessionId: retained.sessionId,
        branch: retained.branch,
        incomingRef: retained.incomingRef,
        checkoutPath: retained.checkoutPath,
        attempts: retained.attempts,
        lastError: retained.lastError,
      });
    }
  }).catch((err: unknown) => {
    log(`[worker] retained-result retry failed unexpectedly (daemon staying up): ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function logShutdownReport(
  report: DrainReport,
  retained: UnpushedResult[],
  timeoutMs: number,
  log: (line: string) => void,
): void {
  for (const result of retained) {
    // #750/#775: the checkout was NOT removed; tell the operator where it is before the process goes away.
    log(
      `[worker] KEPT an unpushed result: sessionId=${result.sessionId} is in ` +
        `${result.checkoutPath} on branch ${result.localBranch} (target ${result.incomingRef}); ` +
        `last push error: ${result.lastError}`,
    );
  }
  if (report.pushesAbandoned > 0 || report.criticalMessagesLost > 0) {
    const named = (report.abandonedSessions ?? []).map((s) => `${s.sessionId} (branch ${s.branch})`).join(", ");
    log(
      `[worker] shutdown INCOMPLETE: ${report.pushesAbandoned} push(es) still in flight after ${Math.round(timeoutMs / 1000)}s` +
        `${named ? `: ${named}` : ""} - saved to undelivered-results.json, checkout kept, delivered on next start; ` +
        `${report.criticalMessagesLost} exit/assign_failed message(s) lost (in-memory queue).`,
    );
  } else {
    log(`[worker] drained cleanly: ${report.pushesCompleted} result push(es) completed`);
  }
}

