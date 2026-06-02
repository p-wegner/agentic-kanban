import { and, eq, inArray, lt } from "drizzle-orm";
import { sessions, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

/** How long a workspace must be in 'active' with a live PID before we reconcile it (hung agent). */
const HUNG_AGENT_THRESHOLD_MS = 30 * 60 * 1000;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

async function workspaceHasCommittedChanges(
  workingDir: string,
  baseBranch: string,
): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    execFile("git", ["diff", "--quiet", baseBranch], { cwd: workingDir }, (err) => resolve(!!err));
  });
}

/**
 * Reconcile workspaces that are stuck in active/reviewing/fixing with a "running"
 * session whose agent has already finished (PID dead or workspace in a post-implementation
 * issue state for >30 minutes).
 *
 * This is the runtime complement to the startup-time fixOrphanedWorkspaces() and
 * cleanupStaleSessions() — it runs periodically so a session that exits without
 * triggering its exit callback (e.g. claude.exe hung after committing) is eventually
 * detected and the workspace unblocked for auto-merge.
 *
 * Returns the number of sessions reconciled.
 */
export async function reconcileCompletionStates(
  database: Database,
  opts: {
    /** Injected for testing — defaults to isPidAlive. */
    checkPid?: (pid: number) => boolean;
    /** Injected for testing — defaults to workspaceHasCommittedChanges. */
    checkCommits?: (workingDir: string, baseBranch: string) => Promise<boolean>;
    /** Current time override for testing. */
    now?: string;
  } = {},
): Promise<number> {
  const checkPid = opts.checkPid ?? isPidAlive;
  const checkCommits = opts.checkCommits ?? workspaceHasCommittedChanges;
  const now = opts.now ?? new Date().toISOString();

  const candidates = await database
    .select({
      sessionId: sessions.id,
      sessionPid: sessions.pid,
      sessionStartedAt: sessions.startedAt,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
      workspaceUpdatedAt: workspaces.updatedAt,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      issueStatusName: projectStatuses.name,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        eq(sessions.status, "running"),
        inArray(workspaces.status, ["active", "reviewing", "fixing"]),
      ),
    );

  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const staleThreshold = new Date(now).getTime() - HUNG_AGENT_THRESHOLD_MS;

  for (const c of candidates) {
    const pid = c.sessionPid;

    let shouldReconcile = false;
    let reason = "";

    if (!pid || !isPidAliveCheck(checkPid, pid)) {
      shouldReconcile = true;
      reason = pid ? `pid=${pid} is dead` : "pid=null (no process was tracked)";
    } else {
      // PID alive — check for hung agent: issue already moved out of In Progress by the
      // agent via MCP, but the process is still running.
      const notInProgress = c.issueStatusName !== "In Progress";
      const updatedAt = new Date(c.workspaceUpdatedAt ?? now).getTime();
      const isStale = updatedAt < staleThreshold;
      if (notInProgress && isStale) {
        shouldReconcile = true;
        reason = `pid=${pid} alive but issue is in '${c.issueStatusName}' and workspace has been active for >${HUNG_AGENT_THRESHOLD_MS / 60000}m`;
      }
    }

    if (!shouldReconcile) continue;

    console.log(
      `[reconciler] stale session detected: sessionId=${c.sessionId} workspaceId=${c.workspaceId} reason=${reason}`,
    );

    await database
      .update(sessions)
      .set({ status: "stopped", endedAt: now })
      .where(eq(sessions.id, c.sessionId));

    await database
      .update(workspaces)
      .set({ status: "idle", updatedAt: now })
      .where(eq(workspaces.id, c.workspaceId));

    console.log(
      `[reconciler] reconciled: sessionId=${c.sessionId} workspaceId=${c.workspaceId} -> session=stopped, workspace=idle`,
    );
    reconciled++;
  }

  return reconciled;
}

function isPidAliveCheck(checkPid: (pid: number) => boolean, pid: number): boolean {
  try {
    return checkPid(pid);
  } catch {
    return false;
  }
}
