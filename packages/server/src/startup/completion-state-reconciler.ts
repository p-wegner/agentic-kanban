import { and, eq, inArray } from "drizzle-orm";
import { sessions, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { isPidAlive } from "../lib/pid.js";

/** How long a workspace must be in 'active' with a live PID before we reconcile it (hung agent). */
const HUNG_AGENT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * #539: was a private third implementation that spawned git raw, outside the git-service
 * SSOT. Now the shared leading-OR-sibling probe — with `onUnknown: false`, deliberately the
 * OPPOSITE of exit-workflow's policy, and that difference is the thing to check before
 * unifying two readers of the same question.
 *
 * exit-workflow answers `true` when git cannot tell, because there "no commits" licenses
 * closing a workspace and forcing its issue Done — acting on an unknown destroys work. Both
 * call sites HERE do the mirror image: `true` makes the reconciler change status (recover a
 * blocked workspace, or mark a dead-PID session stopped) and `false` skips. So an unknown
 * must read as FALSE, or a transient git failure starts reconciling on no evidence at all.
 *
 * What DID change: the sibling half. A sibling-only workspace (#69) commits nothing in the
 * leading worktree, so the old leading-only probe read it as "no work" and this pass never
 * auto-recovered it.
 */
async function workspaceHasCommittedChanges(
  workspace: { id: string; workingDir: string | null; baseBranch: string | null; isDirect?: boolean | null; baseCommitSha?: string | null },
  database: Database,
): Promise<boolean> {
  return workspaceHasCommittedWork(workspace, null, database, { onUnknown: false });
}

/**
 * Reconcile workspaces that are stuck in active/reviewing/fixing with a "running"
 * session whose agent has already finished (PID dead or workspace in a post-implementation
 * issue state for >30 minutes).
 *
 * Also handles blocked workspaces whose most-recent session completed with committed
 * changes — these should auto-recover to idle so the normal review/merge flow can
 * proceed (the propose_transition MCP call may have failed silently leaving the
 * workspace blocked despite the work being done).
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
    checkCommits?: (
      workspace: { id: string; workingDir: string | null; baseBranch: string | null; isDirect?: boolean | null; baseCommitSha?: string | null },
      database: Database,
    ) => Promise<boolean>;
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
      sessionStatus: sessions.status,
      sessionStartedAt: sessions.startedAt,
      workspaceId: workspaces.id,
      workspaceStatus: workspaces.status,
      workspaceUpdatedAt: workspaces.updatedAt,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      baseCommitSha: workspaces.baseCommitSha,
      issueStatusName: projectStatuses.name,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        inArray(sessions.status, ["running", "completed", "stopped"]),
        inArray(workspaces.status, ["active", "reviewing", "fixing", "blocked"]),
      ),
    );

  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const staleThreshold = new Date(now).getTime() - HUNG_AGENT_THRESHOLD_MS;

  for (const c of candidates) {
    const pid = c.sessionPid;

    // Auto-recover blocked workspaces whose most-recent session completed with
    // committed changes. The propose_transition MCP call can fail silently, leaving
    // a workspace blocked even though work was done (#712).
    if (c.workspaceStatus === "blocked" && (c.sessionStatus === "completed" || c.sessionStatus === "stopped")) {
      if (!c.workingDir || !c.baseBranch) continue;
      const hasCommits = await checkCommits(
        { id: c.workspaceId, workingDir: c.workingDir, baseBranch: c.baseBranch, isDirect: c.isDirect, baseCommitSha: c.baseCommitSha },
        database,
      ).catch(() => false);
      if (!hasCommits) continue;

      console.log(
        `[reconciler] blocked workspace with committed changes: workspaceId=${c.workspaceId} sessionId=${c.sessionId} sessionStatus=${c.sessionStatus} — auto-recovering to idle`,
      );
      await setWorkspaceStatus(database, c.workspaceId, "idle", { now });
      console.log(
        `[reconciler] recovered blocked workspace: workspaceId=${c.workspaceId} -> idle`,
      );
      reconciled++;
      continue;
    }

    // For non-blocked workspaces: only process running sessions.
    if (c.sessionStatus !== "running") continue;

    let shouldReconcile = false;
    let reason = "";

    if (!pid || !isPidAliveCheck(checkPid, pid)) {
      // For a dead PID (not null), verify the agent committed work before marking stopped.
      // This prevents false positives from transient PID-check failures (e.g. reused PIDs,
      // EPERM edge cases) from killing sessions that are actually still producing output.
      // If workingDir or baseBranch is missing we can't verify — skip to be safe.
      if (pid && c.workingDir && c.baseBranch) {
        const hasCommits = await checkCommits(
          { id: c.workspaceId, workingDir: c.workingDir, baseBranch: c.baseBranch, isDirect: c.isDirect, baseCommitSha: c.baseCommitSha },
          database,
        ).catch(() => false);
        if (!hasCommits) continue;
      }
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

    await setWorkspaceStatus(database, c.workspaceId, "idle", { now });

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
