/**
 * Cooperative cancellation for a workspace's in-flight merge gate (#1164).
 *
 * The gate's actual work (`runSetupScript`) already accepts an `AbortSignal` and, on abort,
 * kills the spawned process tree and resolves rather than rejects (#989) — that machinery is
 * reused here rather than re-invented. This module is the workspace-keyed registry that lets
 * `POST /:id/merge/cancel` reach the signal for the ONE workspace whose gate it wants to stop,
 * without threading a controller through every layer between the route and the gate.
 *
 * Deliberately in-memory, matching `merge-job.service.ts`'s own map: cancellation is about a
 * LIVE process in THIS server process, so there is nothing to persist past a restart (a
 * restarted server has no gate running for anyone, cancelled or not).
 */

const controllers = new Map<string, AbortController>();

/**
 * Register a fresh controller for a workspace's gate run, replacing any stale one. Called once
 * per gate invocation, before the first `runSetupScript` call — so a signal handed to
 * `runSetupScript` is always this run's own, never a previous run's leftover.
 */
export function beginMergeGateRun(workspaceId: string): AbortSignal {
  controllers.get(workspaceId)?.abort();
  const controller = new AbortController();
  controllers.set(workspaceId, controller);
  return controller.signal;
}

/** Clear the controller once the gate run has settled, so a later cancel has nothing to hit. */
export function endMergeGateRun(workspaceId: string): void {
  controllers.delete(workspaceId);
}

/**
 * Request cancellation of whatever gate run is registered for this workspace. Returns `true`
 * when a live run was found and asked to stop, `false` when there was nothing running here —
 * the caller (the cancel route) uses that to report an honest outcome rather than claiming a
 * cancel that had nothing to act on.
 */
export function requestMergeGateCancellation(workspaceId: string): boolean {
  const controller = controllers.get(workspaceId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Is a gate run for this workspace currently registered (i.e. potentially cancellable)? */
export function hasMergeGateRun(workspaceId: string): boolean {
  return controllers.has(workspaceId);
}

/** Test seam: drop all tracked controllers between tests. */
export function resetMergeCancellation(): void {
  controllers.clear();
}
