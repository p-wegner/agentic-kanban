import type { Database } from "../../db/index.js";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import { insertSessionMessages } from "../../repositories/broadcast.repository.js";
import { recordAgentProfileLaunchFailure } from "../agent-profile-health.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { ProviderName } from "../agent-provider.js";
import { teardownSessionState } from "./types.js";
import type { SessionState } from "./types.js";

/**
 * The launch a session row is a promise of, and the finalizer that keeps the two honest.
 *
 * `startSessionInner` inserts the row as `running` and then does ~380 more lines of
 * fallible, awaited work — provider rotation, devcontainer provisioning, worker placement —
 * before the spawn. Every throw in that stretch used to escape with the row still
 * `running`, no pid, no process, no output and no failure record: an agent that the board
 * believes is working and that does not exist. #876 is one — created 13:24, zero bytes of
 * output, reaped 15 minutes later by the completion-state reconciler, which is the only
 * thing that ever noticed and which says nothing when it does.
 *
 * The trace records what the finalizer needs, and `startSession` wraps the whole body —
 * not just the spawn — in the one failure path. `finalized` makes it idempotent: the inner
 * catch around the spawn goes through the same finalizer, and the wrapper then leaves it
 * alone.
 *
 * It lives beside the lifecycle rather than inside it because the lifecycle is at the
 * god-module ceiling and this is the cohesive piece to lift out: it is the only code in
 * that file whose whole job is what happens when a launch does NOT proceed, and it needs
 * nothing from the launch's own closure beyond the two seams passed in.
 */
export interface LaunchTrace {
  sessionId?: string;
  workspaceId?: string;
  provider?: ProviderName;
  profileName?: string;
  rowInserted: boolean;
  finalized: boolean;
}

export function newLaunchTrace(): LaunchTrace {
  return { rowInserted: false, finalized: false };
}

/**
 * End an orphaned launch VISIBLY: the reason as a stderr message (so it lands in
 * `session_messages` and the session output the UI reads), exit code 1 (so the row
 * classifies as a failure rather than the indeterminate `stopped`/`exitCode=null` that
 * carries no information), the workspace back to idle, and the profile's launch-failure
 * record updated so the breaker can count it.
 */
export async function failLaunch(
  trace: LaunchTrace,
  err: unknown,
  ctx: { db: Database; state: SessionState },
): Promise<void> {
  if (!trace.rowInserted || trace.finalized || !trace.sessionId) return;
  trace.finalized = true;
  const { db, state } = ctx;
  const sessionId = trace.sessionId;
  const reason = errorMessage(err);
  console.error(`[session] launch failed before the agent produced output: sessionId=${sessionId} reason=${reason}`);
  await insertSessionMessages(
    sessionId,
    [{ type: "stderr", data: `Agent launch failed: ${reason}`, exitCode: null }],
    trace.provider ?? null,
    db,
  ).catch(() => {});
  await lifecycleRepo.updateSessionStoppedWithStats(
    sessionId,
    new Date().toISOString(),
    "1",
    JSON.stringify({ launchFailure: { reason, at: new Date().toISOString() } }),
    db,
  ).catch(() => {});
  if (trace.workspaceId) {
    await lifecycleRepo.updateWorkspaceStatus(trace.workspaceId, "idle", new Date().toISOString(), db)
      .catch(() => {});
  }
  await recordAgentProfileLaunchFailure(db, {
    provider: trace.provider ?? "claude",
    profileName: trace.profileName,
    summary: reason,
    exitCode: 1,
    sessionId,
    workspaceId: trace.workspaceId,
  }).catch(() => {});
  teardownSessionState(state, sessionId);
}
