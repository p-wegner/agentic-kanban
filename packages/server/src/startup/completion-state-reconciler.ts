import { and, desc, eq, inArray } from "drizzle-orm";
import { sessions, sessionMessages, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { isPidAlive } from "../lib/pid.js";
import { classifySessionLiveness, type LivenessVerdict } from "../services/remote-session-liveness.js";
import { probeRemoteSessionLiveness } from "../services/fleet-liveness-probe.js";
import { insertSessionMessages } from "../repositories/broadcast.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import {
  readTier0Capacity,
  readCpuBusyPct,
  classifyHeavyProbeSaturation,
} from "@agentic-kanban/shared/lib/machine-capacity";
import { resolveGateBusy } from "../services/base-branch-health-reprobe.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** How long a workspace must be in 'active' with a live PID before we reconcile it (hung agent). */
const HUNG_AGENT_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * #1212 — how long a LIVE session must have said NOTHING before it counts as stale.
 *
 * The wall-clock rule alone read duration as death: a per-ticket code-review session that
 * legitimately ran past 30 minutes on a 100%-CPU box was stopped mid-stream, its workspace
 * dropped to `idle` without `readyForMerge`, and nothing re-queued the review. Staleness is
 * SILENCE (the shape #887 already uses for remote sessions via `ASSIGN_SILENCE_PROBE_MS`),
 * and the 30-minute rule stays only as a backstop that must be satisfied TOO — so a session
 * that is still producing output is never reaped, whatever its age.
 */
export const STALE_SESSION_SILENCE_MS = 15 * 60 * 1000;

/**
 * #1196/#1009's reasoning, applied to the reaper: a saturated host is exactly when a healthy
 * session takes longer than usual, so both windows double rather than the reaper getting
 * trigger-happy at the worst possible moment.
 */
export const SATURATED_HOST_WINDOW_MULTIPLIER = 2;

/** The same host reading the base-health probe holds on (#1009/#1173/#957). */
async function readHostSaturated(): Promise<boolean> {
  try {
    if (resolveGateBusy()) return true;
    const capacity = readTier0Capacity();
    const cpuPct = await readCpuBusyPct().catch(() => null);
    return classifyHeavyProbeSaturation({ freeGb: capacity.freeGb, cpuPct }).hold;
  } catch {
    // A reading we cannot take is not evidence of saturation, but it must not widen the
    // window either — fail to the narrow, existing behaviour.
    return false;
  }
}

/**
 * When this session last SAID anything: the newest `session_messages` row, or its launch
 * stamp when it has produced nothing at all. There is no `lastOutputAt` column; the message
 * table is the board's only record of an agent's output and tool events.
 */
async function lastActivityMsOf(
  sessionId: string,
  startedAt: string | null,
  database: Database,
  fallbackMs: number,
): Promise<number> {
  const rows = await database
    .select({ createdAt: sessionMessages.createdAt })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt))
    .limit(1)
    .catch(() => [] as { createdAt: string }[]);
  const stamps = [rows[0]?.createdAt, startedAt]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms)) as number[];
  return stamps.length > 0 ? Math.max(...stamps) : fallbackMs;
}

/** The hung-agent decision, kept pure so the windows are a table rather than a sweep. */
export function decideHungAgentReap(input: {
  notInProgress: boolean;
  silentMs: number;
  ageMs: number;
  hostSaturated: boolean;
}): { reap: boolean; silenceWindowMs: number; wallClockWindowMs: number } {
  const multiplier = input.hostSaturated ? SATURATED_HOST_WINDOW_MULTIPLIER : 1;
  const silenceWindowMs = STALE_SESSION_SILENCE_MS * multiplier;
  const wallClockWindowMs = HUNG_AGENT_THRESHOLD_MS * multiplier;
  const reap = input.notInProgress && input.silentMs >= silenceWindowMs && input.ageMs >= wallClockWindowMs;
  return { reap, silenceWindowMs, wallClockWindowMs };
}

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
    /**
     * Injected for testing — defaults to probeRemoteSessionLiveness. Answers
     * liveness for a session running on a fleet worker, where the board holds no
     * process handle at all (#744).
     */
    probeRemote?: (
      row: { workerId: string; startedAt?: string | null },
      database: Database,
      probeOpts: { nowMs: number },
    ) => Promise<LivenessVerdict>;
    /**
     * Injected for testing — defaults to the shared capacity readers (#1009/#1173/#957).
     * Read at most ONCE per pass, and only when a live session is actually a candidate.
     */
    hostSaturated?: () => Promise<boolean>;
    /**
     * #1212 — how a reaped REVIEW session gets its review back. The same service function
     * `POST /api/workspaces/:id/review` calls, injected rather than reached by self-HTTP
     * (see `packages/server/CLAUDE.md`). Absent (a caller that has no session manager) means
     * the re-queue is REPORTED as impossible, never silently skipped.
     */
    requeueReview?: (workspaceId: string) => Promise<{ sessionId: string }>;
    /** Current time override for testing. */
    now?: string;
  } = {},
): Promise<number> {
  const checkPid = opts.checkPid ?? isPidAlive;
  const checkCommits = opts.checkCommits ?? workspaceHasCommittedChanges;
  const probeRemote = opts.probeRemote ?? probeRemoteSessionLiveness;
  const hostSaturatedReader = opts.hostSaturated ?? readHostSaturated;
  const now = opts.now ?? new Date().toISOString();
  const nowMs = new Date(now).getTime();

  const candidates = await database
    .select({
      sessionId: sessions.id,
      sessionPid: sessions.pid,
      sessionWorkerId: sessions.workerId,
      sessionStatus: sessions.status,
      sessionStartedAt: sessions.startedAt,
      sessionTriggerType: sessions.triggerType,
      issueId: issues.id,
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
  // One reading per pass at most, taken lazily: a sweep that finds nothing alive must not
  // spend 150 ms sampling CPU on every tick.
  let hostSaturatedOnce: Promise<boolean> | null = null;
  const hostSaturated = () => (hostSaturatedOnce ??= hostSaturatedReader());

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

    // #744: this pass used to read `!pid` as proof of death. A session dispatched to
    // a fleet worker has NO local pid by construction, so every running remote
    // session was force-stopped on the first tick with candidates — its workspace
    // idled and the ticket relaunched, putting two agents on one branch. Liveness is
    // now decided in ONE place that knows the difference between "no process" and
    // "no information" (services/remote-session-liveness.ts), and an `unknown`
    // verdict HOLDS: the board reports what it cannot see and changes nothing.
    const verdict: LivenessVerdict = c.sessionWorkerId
      ? await probeRemote(
          { workerId: c.sessionWorkerId, startedAt: c.sessionStartedAt },
          database,
          { nowMs },
        ).catch((err) => {
          console.error(`[reconciler] remote liveness probe failed for session ${c.sessionId}`, err);
          return { liveness: "unknown" as const, reason: "remote liveness probe failed" };
        })
      : classifySessionLiveness({ pid, workerId: null }, { checkPid });

    if (verdict.liveness === "unknown") {
      console.log(
        `[reconciler] holding session ${c.sessionId} (workspace ${c.workspaceId}): ${verdict.reason}. ` +
          `Nothing is changed while the board cannot tell — it is an observer of remote work, not its owner.`,
      );
      continue;
    }

    if (verdict.liveness === "dead") {
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
      reason = verdict.reason;
    } else {
      // PID alive — a hung agent is one that has gone SILENT, not merely one that has been
      // running a while (#1212). Both windows must be satisfied: the session said nothing for
      // the silence window AND the workspace has been sitting in a post-implementation state
      // for the wall-clock backstop. A saturated host doubles both.
      const notInProgress = c.issueStatusName !== "In Progress";
      const saturated = notInProgress ? await hostSaturated() : false;
      const lastActivity = notInProgress
        ? await lastActivityMsOf(c.sessionId, c.sessionStartedAt, database, nowMs)
        : nowMs;
      const silentMs = Math.max(0, nowMs - lastActivity);
      const ageMs = Math.max(0, nowMs - new Date(c.workspaceUpdatedAt ?? now).getTime());
      const decision = decideHungAgentReap({ notInProgress, silentMs, ageMs, hostSaturated: saturated });
      if (decision.reap) {
        shouldReconcile = true;
        reason =
          `${verdict.reason} but issue is in '${c.issueStatusName}' and the session has been ` +
          `silent for ${Math.round(silentMs / 60000)} min ` +
          `(silence window ${decision.silenceWindowMs / 60000}m, backstop ${decision.wallClockWindowMs / 60000}m` +
          `${saturated ? ", doubled: host saturated" : ""})`;
      }
    }

    if (!shouldReconcile) continue;

    console.log(
      `[reconciler] stale session detected: sessionId=${c.sessionId} workspaceId=${c.workspaceId} reason=${reason}`,
    );

    // Say so where the session is READ, not only in the server console (#876). This sweep
    // is frequently the only thing that ever notices a session that produced nothing — a
    // launch that died before the spawn leaves a row with no pid, no output and no exit —
    // and stopping it silently is what makes the workspace look like an agent ran and had
    // nothing to say. The reason goes in as a stderr message so it reaches the session
    // output the UI renders, and the exit code stops being NULL so the row classifies as
    // a failure instead of an indeterminate stop.
    await insertSessionMessages(
      c.sessionId,
      [{ type: "stderr", data: `Session reconciled by the board, not by the agent: ${reason}`, exitCode: null }],
      null,
      database,
    ).catch(() => {});

    await database
      .update(sessions)
      .set({ status: "stopped", endedAt: now, exitCode: "1" })
      .where(eq(sessions.id, c.sessionId));

    await setWorkspaceStatus(database, c.workspaceId, "idle", { now });

    console.log(
      `[reconciler] reconciled: sessionId=${c.sessionId} workspaceId=${c.workspaceId} -> session=stopped, workspace=idle`,
    );

    // #1212 — a reaped REVIEW session leaves the ticket In Review with no verdict and nothing
    // to produce one, which is how #1203 needed a human to re-trigger it by hand. A builder
    // session keeps today's behaviour: the monitor already relaunches those.
    if (c.sessionTriggerType === "review") {
      await requeueReapedReview({ database, opts, workspaceId: c.workspaceId, issueId: c.issueId, reason, now });
    }

    reconciled++;
  }

  return reconciled;
}

/**
 * Put a reaped review back in the queue and SAY SO on the ticket (#1212).
 *
 * Non-fatal in both halves: a failed relaunch or a failed comment must not take the sweep
 * around it down, and each failure is reported rather than swallowed — the whole defect this
 * fixes was a review that vanished quietly.
 */
async function requeueReapedReview(input: {
  database: Database;
  opts: { requeueReview?: (workspaceId: string) => Promise<{ sessionId: string }> };
  workspaceId: string;
  issueId: string;
  reason: string;
  now: string;
}): Promise<void> {
  const { database, opts, workspaceId, issueId, reason, now } = input;
  if (!opts.requeueReview) {
    console.warn(
      `[reconciler] stopped review session for workspace ${workspaceId} but no review launcher is wired — ` +
        `the review is NOT re-queued and the ticket needs one by hand`,
    );
    return;
  }
  let body: string;
  try {
    const { sessionId } = await opts.requeueReview(workspaceId);
    body =
      `The board stopped this ticket's code-review session and re-queued the review ` +
      `(new session \`${sessionId}\`).

Why it was stopped: ${reason}`;
    console.log(`[reconciler] re-queued review for workspace ${workspaceId} session=${sessionId}`);
  } catch (err) {
    body =
      `The board stopped this ticket's code-review session and could not re-queue the review: ` +
      `${errorMessage(err)}.

Why it was stopped: ${reason}`;
    console.warn(`[reconciler] failed to re-queue review for workspace ${workspaceId}:`, errorMessage(err));
  }
  await insertIssueComment(
    { issueId, workspaceId, kind: "note", author: "system", body, createdAt: now },
    database,
  ).catch((err) => {
    console.warn(`[reconciler] failed to write re-queued-review comment for workspace ${workspaceId}:`, errorMessage(err));
  });
}
