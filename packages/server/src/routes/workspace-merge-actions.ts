import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { resetMergeBackoffForExplicitMerge } from "../services/merge-backoff.service.js";
import { cancelMergeJob, completeMergeJob, failMergeJob, getMergeJob, startMergeJob } from "../services/merge-job.service.js";
import { requestMergeGateCancellation } from "../services/merge-cancellation.js";
import { cancelQueuedVerifyChain } from "../services/verify-chain-semaphore.js";
import { releaseMergeLockForWorkspace } from "../services/workspace-internals.js";
import { clearMergeHold, getMergeHold, setMergeHold } from "../repositories/merge-hold.repository.js";

/**
 * `POST /:id/merge` job orchestration — decide whether to start a fresh tracked merge job or
 * join one already running, then wire the actual merge promise to complete/fail it.
 *
 * Extracted out of `workspace-actions.ts` for the `function-nloc-ratchet` (#800) /
 * god-module (#1164) reasons documented in that file's own header comments — this function
 * only moves the code, not the behavior. The route handler's own doc comment (see the call
 * site in `workspace-actions.ts`) explains the #903 retry/zombie subtleties this preserves
 * verbatim.
 */
export function runWorkspaceMergeJob(
  id: string,
  workspaceService: ReturnType<typeof createWorkspaceService>,
  opts: { database?: Database } = {},
): { jobId: string; run: Promise<Awaited<ReturnType<typeof workspaceService.mergeWorkspaceDeduped>>> } {
  const existingJob = getMergeJob(id);
  const joiningExisting = existingJob !== null && existingJob.state === "running";
  const wasZombied = existingJob?.reason === "merge_job_zombied";
  const job = joiningExisting ? existingJob : startMergeJob(id);
  const ownsJob = !joiningExisting;
  // #1230 — an EXPLICIT merge request runs immediately and resets the auto-merge backoff: the
  // merge path below never consults `shouldSkipMergeForBackoff` (only the orchestrator's tick
  // and the monitor walk do), so the bypass is by construction; the clear is what makes the
  // operator's request also the reset. Awaited before the merge so the row cannot outlive it.
  const reset = ownsJob ? resetMergeBackoffForExplicitMerge(id, opts.database) : Promise.resolve();
  const run = reset
    .then(() => workspaceService.mergeWorkspaceDeduped(id, { deferMainCheckoutSync: true, dropStaleActiveRequest: wasZombied }))
    .then((result) => {
      if (ownsJob) completeMergeJob(job.jobId, id, result);
      return result;
    })
    .catch((err) => {
      if (ownsJob) failMergeJob(job.jobId, id, err);
      throw err;
    });
  return { jobId: job.jobId, run };
}

/**
 * `POST /:id/merge/cancel` (#1164): the targeted lever a stuck/red merge previously had none
 * of — before this there was no way to stop ONE workspace's merge job or verify chain short of
 * killing gate processes by hand (forbidden) or disabling auto-merge for the whole project.
 *
 * This does four things, each independently idempotent so calling it on a workspace with
 * nothing running is a harmless 200 rather than an error:
 *   - removes a QUEUED (not yet admitted) verify chain from the semaphore, freeing the slot
 *     for the next waiter immediately, before it ever ran;
 *   - aborts an IN-FLIGHT gate run via its `AbortSignal` — `runSetupScript` (#989) kills the
 *     spawned process tree on abort and resolves rather than rejects, so no orphan survives;
 *   - releases the in-process repo merge lock if this workspace holds it, so a genuinely
 *     stuck merge does not also block every other workspace targeting the same repo;
 *   - marks the tracked merge job `cancelled` so `GET /merge-status` reports the true outcome
 *     instead of a job that silently stops updating.
 *
 * The verify-chain semaphore's queue label is never the bare workspace id: the gate's three
 * callers (verify, boot/render smoke, E2E smoke lane — pre-merge-gate.service.ts and
 * e2e-smoke-lane.ts) each label their wait `"<kind> for workspace <id>"`, and
 * `cancelQueuedVerifyChain` matches by exact label string. Try every label a queued wait for
 * this workspace could carry; at most one is ever queued at a time, so at most one removal
 * fires.
 *
 * Extracted out of `workspace-actions.ts` for the same reasons as `runWorkspaceMergeJob` above.
 */
export function cancelWorkspaceMerge(
  id: string,
  reason: string | undefined,
): {
  workspaceId: string;
  cancelled: boolean;
  wasQueued: boolean;
  wasGating: boolean;
  releasedLock: boolean;
  jobCancelled: boolean;
  reason: string;
} {
  const resolvedReason = reason?.trim() || "cancelled by operator";
  const wasQueued = [
    `verify chain for workspace ${id}`,
    `smoke check for workspace ${id}`,
    `E2E smoke lane for workspace ${id}`,
  ].some((label) => cancelQueuedVerifyChain(label));
  const wasGating = requestMergeGateCancellation(id);
  const heldLock = releaseMergeLockForWorkspace(id);
  const hadJob = cancelMergeJob(id, resolvedReason);

  return {
    workspaceId: id,
    cancelled: wasQueued || wasGating || heldLock || hadJob,
    wasQueued,
    wasGating,
    releasedLock: heldLock,
    jobCancelled: hadJob,
    reason: resolvedReason,
  };
}

/**
 * `POST /merge-hold` body (#1164): place or refresh a per-workspace merge hold.
 *
 * Extracted out of `workspace-actions.ts` for the same reasons as `runWorkspaceMergeJob` above.
 */
export async function placeWorkspaceMergeHold(
  id: string,
  reason: string | undefined,
  database: Database,
): Promise<{ workspaceId: string; held: true; reason: string | null; heldAt: string }> {
  const heldAt = new Date().toISOString();
  const trimmedReason = reason?.trim() || null;
  await setMergeHold(id, { reason: trimmedReason, heldAt }, database);
  return { workspaceId: id, held: true, reason: trimmedReason, heldAt };
}

/**
 * `DELETE /merge-hold` body (#1164): release a hold. A no-op (not an error) when the
 * workspace was not held. Extracted for the same reason as `runWorkspaceMergeJob` above.
 */
export async function releaseWorkspaceMergeHold(
  id: string,
  database: Database,
): Promise<{ workspaceId: string; held: false }> {
  await clearMergeHold(id, database);
  return { workspaceId: id, held: false };
}

/**
 * `GET /merge-hold` body (#1164): current hold state, for the UI panel. Extracted for the
 * same reason as `runWorkspaceMergeJob` above.
 */
export async function getWorkspaceMergeHoldState(
  id: string,
  database: Database,
): Promise<{ workspaceId: string; held: boolean; reason?: string | null; heldAt?: string }> {
  const row = await getMergeHold(id, database);
  return row
    ? { workspaceId: id, held: true, reason: row.reason, heldAt: row.heldAt }
    : { workspaceId: id, held: false };
}
