// Process-tree ownership of the agents a worker daemon launches (#1336): the registry record,
// the Windows kill-on-close job, `--leave-agents` release, and the startup cleanup that kills a
// previous daemon's leftovers before its checkouts are reaped.

import { workerLog } from "./worker-updater.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { forgetAgent, markAgentsLeftOnPurpose, recordAgent, sweepLeftoverAgents } from "./worker-agent-registry.js";
import { attachAgentJob, type AgentJob } from "./worker-job-holder.js";
import { reapOrphanedCheckouts } from "./worker-repo.js";

export interface AgentTreeTracker {
  /** Record a freshly spawned agent and (win32) put it in a kill-on-close job. */
  track(sessionId: string, pid: number, cwd?: string): void;
  /** The agent exited: drop its record and job handle. */
  untrack(sessionId: string): void;
  /** `--leave-agents`: the trees survive on purpose; the next daemon's sweep skips them. */
  release(sessionIds: string[]): void;
}

export function createAgentTreeTracker(workRoot: string): AgentTreeTracker {
  const jobs = new Map<string, AgentJob>();
  return {
    track(sessionId, pid, cwd) {
      recordAgent(workRoot, { sessionId, pid, cwd, startedAt: new Date().toISOString(), daemonPid: process.pid });
      const job = attachAgentJob(pid, (line) => workerLog(line));
      if (job) jobs.set(sessionId, job);
    },
    untrack(sessionId) {
      jobs.delete(sessionId);
      forgetAgent(workRoot, sessionId);
    },
    release(sessionIds) {
      for (const job of jobs.values()) job.release();
      jobs.clear();
      markAgentsLeftOnPurpose(workRoot, sessionIds);
    },
  };
}

/**
 * Daemon startup cleanup, best-effort: kill what a previous daemon's agents left running, THEN
 * reap the orphaned checkouts (#850) so nothing still holds files in them. Never throws.
 */
export async function cleanUpBeforeStart(workRoot: string, log: (line: string) => void): Promise<void> {
  try {
    await sweepLeftoverAgents(workRoot, log);
  } catch (err) {
    log(`[worker] leftover-agent sweep failed (continuing): ${errorMessage(err)}`);
  }
  try {
    const reaped = await reapOrphanedCheckouts(workRoot, log);
    if (reaped.reaped.length > 0) {
      log(`[worker] startup cleanup: reaped ${reaped.reaped.length} orphaned checkout(s) of ${reaped.scanned} scanned`);
    }
  } catch (err) {
    log(`[worker] startup checkout cleanup failed (continuing): ${errorMessage(err)}`);
  }
}
