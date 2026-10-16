// Two leaves of the remote agent service's give-up/exit paths (#1345): landing a
// session's pushed branch (`landSessionBranch`) and stopping sessions a worker reports
// that this process does not track (`stopUntrackedSessions`).
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { getSessionLiveness } from "../repositories/worker.repository.js";
import { landWithRebaseAdoption, clearIncomingRef } from "./worker-remote-sync.service.js";
import type { WorkerConnectionManager } from "./worker-connection.service.js";
import type { RemoteSession } from "./agent-remote.types.js";

/**
 * Land whatever the worker pushed onto the real branch (#743 `syncIncomingBranch`) and
 * return the exit code to record. A sync failure downgrades the code, so a session whose
 * work did not land is never recorded as a clean success.
 */
export async function landSessionBranch(
  sessionId: string,
  session: RemoteSession,
  reportedExitCode: number | null,
  /**
   * #1420: the worker is gone and its exit report with it, but a result WAS pushed (the worker
   * only pushes after the agent exited). Landing it is then the best evidence of a finished run,
   * so record exit 0 rather than the placeholder 1 — the implement-exit check and review run.
   */
  landedPushMeansSuccess = false,
): Promise<number | null> {
  let exitCode = reportedExitCode;
  if (!session.repo) return exitCode;
  try {
    const landed = await landWithRebaseAdoption(session.repo.repoPath, session.repo.branch);
    const result = landed.outcome;
    if (landed.adoption) {
      // #1446/#1521: a clean rebase onto a newer base is the worker doing what it was told,
      // whatever the agent's own exit code was.
      console.log(`[agent-remote] session ${sessionId}: ${landed.adoption.summary}`);
      session.onOutput({ type: "stdout", sessionId, data: landed.adoption.summary });
      await clearIncomingRef(session.repo.repoPath, session.repo.branch).catch(() => {});
      if (landedPushMeansSuccess) exitCode = 0;
    } else if (result.ok) {
      console.log(`[agent-remote] synced ${session.repo.branch} (${result.status}) for session ${sessionId}`);
      if (landedPushMeansSuccess) {
        exitCode = 0;
        console.warn(`[agent-remote] session ${sessionId}: pushed result landed after the worker lost its exit; completed, exit unknown (recorded 0)`);
      }
      await clearIncomingRef(session.repo.repoPath, session.repo.branch).catch(() => {});
    } else if (result.status === "missing" && exitCode !== 0) {
      // The agent failed before producing anything to push — nothing to sync.
      console.warn(`[agent-remote] no incoming ref for failed session ${sessionId}; nothing to sync`);
    } else {
      let classification = landed.classification ?? "";
      if (landed.discardable) {
        // #1427: unusable - a later sync must not be able to land it (#1414).
        await clearIncomingRef(session.repo.repoPath, session.repo.branch).catch(() => {});
        classification += " - incoming ref discarded";
      }
      // #1542: a not-landed result must reach board.log, not only the session transcript.
      console.warn(`[agent-remote] session ${sessionId}: worker result NOT landed on ${session.repo.branch}: ${result.ok ? "" : result.error}${classification}`);
      session.onOutput({
        type: "stderr",
        sessionId,
        data: `Worker result could not be landed on ${session.repo.branch}: ${result.ok ? "" : result.error}${classification}`,
      });
      exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
    }
  } catch (err) {
    session.onOutput({ type: "stderr", sessionId, data: `Branch sync failed: ${errorMessage(err)}` });
    exitCode = exitCode === 0 || exitCode === null ? 1 : exitCode;
  }
  return exitCode;
}

/** A hello listed sessions this process has no memory of: ask the DB, then stop only the genuine orphans. */
export async function stopUntrackedSessions(deps: {
  manager: WorkerConnectionManager;
  database: Database;
  workerId: string;
  sessionIds: string[];
}): Promise<void> {
  const { manager, database, workerId, sessionIds } = deps;
  for (const sessionId of sessionIds) {
    let live: { status: string; workerId: string | null } | null = null;
    try {
      live = await getSessionLiveness(sessionId, database);
    } catch (err) {
      // Fail SAFE: if we cannot tell, do not kill. A stray agent is cheaper
      // than destroying work we were unable to ask about.
      console.error(
        `[agent-remote] could not check session ${sessionId} reported by worker ${workerId}; leaving it running`,
        err,
      );
      continue;
    }
    if (live && live.status === "running" && live.workerId === workerId) {
      console.warn(
        `[agent-remote] worker ${workerId} reports session ${sessionId}, which this process does not track ` +
          `but the DB still has running on that worker — leaving it alone. Its output is not being streamed; ` +
          `its result will land from the incoming ref on the next startup sweep.`,
      );
      continue;
    }
    const why = !live ? "no session row" : `row is ${live.status}` + (live.workerId === workerId ? "" : " on another worker");
    console.warn(
      `[agent-remote] worker ${workerId} reports unknown session ${sessionId} (${why}); stopping the orphan`,
    );
    manager.send(workerId, { type: "stop", sessionId });
  }
}
