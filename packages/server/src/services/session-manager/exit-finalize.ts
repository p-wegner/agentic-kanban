import { buildUsageLimitStats } from "@agentic-kanban/shared/lib/session-stats-blob";
import type { Database } from "../../db/index.js";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import { updateWorkspaceLaunchFailure, clearWorkspaceLaunchError } from "../../repositories/workspace-crud.repository.js";
import { recordAgentProfileLaunchFailure } from "../agent-profile-health.service.js";
import { recordAgentProfileLaunchSuccess } from "../agent-profile-failure-record.js";
import { applyAuthFailureRecovery } from "../provider-auth-recovery.js";
import { emitButlerSystemEvent } from "../butler-event-feed.js";
import type { ProviderName } from "../agent-provider.js";
import type { classifySessionExit } from "./session-exit-state-machine.js";
import {
  buildZeroOutputLaunchFailureStats,
  buildModelErrorLaunchFailureStats,
  buildStaleResumeLaunchFailureStats,
  launchFailureButlerText,
} from "./session-exit-stats.js";
import { mergeExistingSessionStats } from "./session-launch-helpers.js";
import { probeProcessTree, type TreeLiveness } from "../../lib/process-tree.js";

type Route = ReturnType<typeof classifySessionExit>;
export type UsageLimitRoute = Extract<Route, { phase: "usage-limit" }>;
export type LaunchFailureRoute = Extract<Route, { phase: "launch-failure" }>;

/**
 * Everything a terminal route needs that is NOT on the route itself.
 *
 * #543: this exists because the FINALIZE side of the exit state machine was written twice —
 * once for a live session (`handleExitEvent`) and once for a reattached one
 * (`notifyExternalExit`) — and the two copies then drifted in three separate places, each
 * silently: the external launch-failure path skipped `applyAuthFailureRecovery` (#430), the
 * external completed path never cleared the profile's failure streak, and every external
 * failure was recorded WITHOUT a profile name, i.e. under a key the breaker does not read.
 * Sharing the core makes that class of drift structural rather than a list to keep in sync.
 *
 * The two provider names are deliberately separate fields, not one: the live path records
 * profile HEALTH under `lifecycleProviderName(provider, profile)` (which can name a
 * configured provider) and does auth recovery under `narrowProviderName(executor)` (the
 * actual launched binary). Collapsing them would silently re-file one of the two.
 */
export interface ExitFinalizeContext {
  db: Database;
  sessionId: string;
  /** Absent only for an external exit whose session context was already lost. */
  workspaceId: string | undefined;
  projectId: string | undefined;
  /** The launched provider id, as it is labelled in session stats. */
  executor: string;
  /** Provider key the profile-health breaker is recorded under. */
  healthProviderName: ProviderName;
  /** Provider key auth-failure recovery rotates within. */
  authProviderName: ProviderName;
  profileName: string | undefined;
  durationMs: number;
  /** The raw observed exit code — stats keep this, the DB gets the route's effective one. */
  exitCode: number | null;
  capturedStderr: string;
  now: string;
  /**
   * The host pid this session was launched as, when the board holds one (#968). Absent for a
   * remote/fleet session, and for an external exit whose session context was already lost —
   * both of which make the survivor probe below inapplicable rather than negative.
   */
  pid?: number | null;
  /** Injected for testing. Defaults to the real process-table probe. */
  probeTree?: (pid: number | null | undefined) => Promise<TreeLiveness> | TreeLiveness;
}

/**
 * Non-fatal by contract: profile health is a breaker input, never a reason to abandon the
 * rest of a terminal route (the external path already treated it that way, and the live path
 * swallowed it in an outer catch that also skipped everything after it).
 */
function recordFailure(ctx: ExitFinalizeContext, summary: string, exitCode: number | null): Promise<void> {
  return recordAgentProfileLaunchFailure(ctx.db, {
    provider: ctx.healthProviderName,
    profileName: ctx.profileName,
    summary,
    exitCode,
    sessionId: ctx.sessionId,
    workspaceId: ctx.workspaceId,
    at: ctx.now,
  }).catch((err) => console.error("Failed to record agent-profile launch failure:", err));
}

async function persistStoppedWithStats(
  ctx: ExitFinalizeContext,
  stats: Parameters<typeof mergeExistingSessionStats>[2],
  exitCode: string | null,
): Promise<void> {
  const merged = await mergeExistingSessionStats(ctx.db, ctx.sessionId, stats);
  await lifecycleRepo.updateSessionStoppedWithStats(ctx.sessionId, ctx.now, exitCode, JSON.stringify(merged), ctx.db);
}

/**
 * usage-limit route: persist rate-limit stats and park the workspace `blocked` so the
 * rotation ring can pick another profile. Returns the exit code the callbacks must see.
 */
export async function finalizeUsageLimitRoute(route: UsageLimitRoute, ctx: ExitFinalizeContext): Promise<number> {
  const { usageLimit, effectiveExitCode } = route;
  // The provider is already a discriminant on both sides (#542) — build the blob from it
  // rather than branching to two builders that differed only in the literal they wrote.
  const stats = buildUsageLimitStats(usageLimit.kind, {
    executor: ctx.executor,
    durationMs: ctx.durationMs,
    exitCode: ctx.exitCode,
    message: usageLimit.message,
    retryAfter: usageLimit.retryAfter,
  });
  await recordFailure(ctx, stats.failureReason, effectiveExitCode);
  await persistStoppedWithStats(ctx, stats, String(effectiveExitCode));
  if (ctx.workspaceId) await lifecycleRepo.updateWorkspaceStatus(ctx.workspaceId, "blocked", ctx.now, ctx.db);
  console.warn(
    `[agent] ${usageLimit.kind}-rate-limited: sessionId=${ctx.sessionId} workspace=${ctx.workspaceId ?? "?"}` +
    `${usageLimit.retryAfter ? ` retryAfter=${usageLimit.retryAfter}` : ""}`,
  );
  return effectiveExitCode;
}

export interface LaunchFailureFinalizeResult {
  effectiveExitCode: number;
  /** True when `applyAuthFailureRecovery` already parked the workspace — see below. */
  authHandled: boolean;
}

/**
 * launch-failure route: record the failure against the profile, persist the stats and the
 * stderr message, then resolve the workspace's status.
 *
 * `isStaleResume` is the live path's missing-transcript sub-route (#26). It changes three
 * things and nothing else, which is why it is a flag rather than a second function: the
 * stats builder, skipping auth recovery (the login is fine — the transcript is gone), and
 * skipping the `idle` write (the caller relaunches instead).
 *
 * The `idle` write is conditional on `authHandled` because `applyAuthFailureRecovery`
 * returns true only when it has ALREADY parked the workspace `blocked` (#430); overwriting
 * that with `idle` is what let the monitor relaunch onto a dead login in a loop.
 *
 * That `idle` write also persists `latestLaunchError` (#859/#895) — it used to be a bare
 * status write, so a launch failure discovered at session-exit time (as opposed to preflight
 * time) left the workspace looking exactly like one that finished cleanly: `idle`, with
 * `latestLaunchError` untouched. The failure reason was already computed a few lines above
 * (`stats.failureReason`) and even persisted onto the SESSION's stats blob; it just never
 * reached the workspace row, which is what `workspace-launch-failures.service.ts` and any
 * other direct reader of the workspace consult first.
 */
export async function finalizeLaunchFailureRoute(
  route: LaunchFailureRoute,
  ctx: ExitFinalizeContext,
  opts: { isStaleResume?: boolean } = {},
): Promise<LaunchFailureFinalizeResult> {
  const { isZeroOutput, isNonZeroExit, effectiveExitCode, errorText } = route;
  const isStaleResume = opts.isStaleResume ?? false;
  const stats = isStaleResume
    ? buildStaleResumeLaunchFailureStats(ctx.executor, ctx.durationMs, ctx.exitCode, errorText || ctx.capturedStderr)
    : isZeroOutput
      ? buildZeroOutputLaunchFailureStats(ctx.executor, ctx.durationMs, ctx.exitCode, ctx.capturedStderr)
      : buildModelErrorLaunchFailureStats(ctx.executor, ctx.durationMs, ctx.exitCode, errorText);

  await recordFailure(ctx, stats.failureReason, effectiveExitCode);
  await persistStoppedWithStats(ctx, stats, String(effectiveExitCode));
  await lifecycleRepo.insertSessionMessage(
    { sessionId: ctx.sessionId, type: "stderr", data: stats.failureReason, exitCode: null },
    ctx.db,
  );

  const wsId = ctx.workspaceId;
  const authHandled = !isStaleResume && wsId
    ? await applyAuthFailureRecovery(ctx.db, {
        // #528: `?? claudeProfile` here used to blame the CLAUDE profile name under a
        // non-claude provider.
        provider: ctx.authProviderName,
        profileName: ctx.profileName,
        errorText: errorText || ctx.capturedStderr,
        workspaceId: wsId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        now: ctx.now,
        setWorkspaceStatus: (status) => lifecycleRepo.updateWorkspaceStatus(wsId, status, ctx.now, ctx.db),
      }).catch(() => false)
    : false;

  if (!isStaleResume && wsId && !authHandled) {
    await updateWorkspaceLaunchFailure(
      wsId,
      { status: "idle", latestLaunchError: stats.failureReason, updatedAt: ctx.now },
      ctx.db,
    );
  }

  if (ctx.projectId && wsId) {
    emitButlerSystemEvent({
      projectId: ctx.projectId,
      kind: "session_failed",
      workspaceId: wsId,
      text: launchFailureButlerText({
        workspaceId: wsId, isStaleResume, isNonZeroExit, effectiveExitCode, durationMs: ctx.durationMs, errorText,
      }),
    });
  }

  return { effectiveExitCode, authHandled };
}

/**
 * A `completed` session whose process tree OUTLIVED it (#968).
 *
 * `exit` means the handle the board held closed — never that the work stopped. On a detached
 * stream-json launch the working `claude.exe` can survive the pid we spawned, reparented, and
 * go on editing files for another twenty minutes. That is precisely what happened: session
 * 62c6722d was recorded `completed` exit 0 while its agent ran on, the workspace therefore
 * looked free, the driving session relaunched it (correctly — the API is for exactly that),
 * and two agents co-edited one worktree.
 *
 * The board cannot make the two facts one, so it records both. The row still says `completed`
 * — the stream did close, and rewriting that would break every reader of the exit code — but
 * a session message states plainly that processes survived. That message is a DIAGNOSTIC, not
 * the guard: `findLiveAgentTrees` (workspace-agent-liveness.service.ts) re-derives the same
 * verdict from the OS at relaunch time, so the refusal never depends on this write having
 * happened. The text is deliberately actionable — it names the surviving pids, because
 * "something is still running" is not something an operator can act on.
 */
export async function recordSurvivingProcessTree(ctx: ExitFinalizeContext): Promise<void> {
  // A remote/fleet session has no host pid by construction — that is "not applicable", not
  // "nothing survived", and probing it would answer about the board's own machine.
  if (ctx.pid == null) return;
  const probe = ctx.probeTree ?? ((pid: number | null | undefined) => probeProcessTree(pid));
  let verdict: TreeLiveness;
  try {
    verdict = await probe(ctx.pid);
  } catch (err) {
    console.error(`[session] process-tree probe threw: sessionId=${ctx.sessionId}`, err);
    return;
  }
  // `dead` is the ordinary case and needs no note. `unknown` is deliberately silent too: it
  // means the process table could not be read, which happens for reasons unrelated to this
  // session, and a survivor warning on every failed enumeration would train operators to
  // ignore the real one. The relaunch guard makes the same call for the same reason.
  if (verdict.liveness !== "alive") return;

  const text =
    `Session recorded 'completed' (exit ${ctx.exitCode ?? 0}) but its process tree SURVIVED: ${verdict.reason}. ` +
    `The agent may still be working in this worktree. A relaunch here would put two agents on one ` +
    `branch, so it is refused until these processes exit (override with force). Check them before ` +
    `relaunching: ${verdict.pids.join(", ")}.`;
  console.warn(`[session] ${text} sessionId=${ctx.sessionId} workspace=${ctx.workspaceId ?? "?"}`);
  await lifecycleRepo
    .insertSessionMessage({ sessionId: ctx.sessionId, type: "stderr", data: text, exitCode: null }, ctx.db)
    .catch((err) => console.error(`[session] failed to record surviving process tree: sessionId=${ctx.sessionId}`, err));
}

/**
 * completed route: mark the session completed and clear the profile's failure streak.
 *
 * The streak clear is #430's other half — a session that actually RAN proves the login
 * works, so the breaker can never outlive the problem. It was missing from the external
 * path, which meant a REATTACHED session that ran fine left a healthy profile marked
 * unusable. Everything else the live path does on this route (HANDOFF.md, the scorecard,
 * plan-mode, the ExitPlanMode auto-resume) needs the launch options and stays with it.
 *
 * #968 added the survivor probe: "the stream closed" and "the process is gone" are two
 * different facts and this route used to record only the first. See
 * {@link recordSurvivingProcessTree}.
 *
 * That probe is fired but NOT awaited. It reads the whole OS process table — a subprocess
 * that can take seconds — and it produces a diagnostic note, never a state transition. Every
 * caller of this function goes on to fire `onSessionExit`, which is what advances the
 * workflow and can launch the next session; making that wait on a process enumeration would
 * put a multi-second stall on the critical path of every clean exit, in exchange for a
 * message whose whole audience reads it later.
 */
export async function finalizeCompletedRoute(ctx: ExitFinalizeContext, exitCode: number | null): Promise<void> {
  await lifecycleRepo.updateSessionCompleted(ctx.sessionId, ctx.now, String(exitCode ?? 0), ctx.db);
  void recordSurvivingProcessTree(ctx).catch(() => {});
  await recordAgentProfileLaunchSuccess(ctx.db, {
    provider: ctx.authProviderName,
    profileName: ctx.profileName,
  }).catch(() => {});
  // A completed session PROVES this workspace can launch — clear any stale `latestLaunchError`
  // from an earlier failure (#895 follow-up), or the launch-failures digest keeps reporting
  // `preflight-failed` from a problem that no longer exists (see the field's write site above).
  if (ctx.workspaceId) {
    await clearWorkspaceLaunchError(ctx.workspaceId, ctx.db).catch((err) =>
      console.error(`[session] failed to clear workspace launch error: workspaceId=${ctx.workspaceId}`, err),
    );
  }
}
