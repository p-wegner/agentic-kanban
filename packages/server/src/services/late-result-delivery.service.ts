// A worker result that arrives AFTER the board gave up on the session (#1414).
//
// The exit path (`landSessionBranch`) lands whatever is in `refs/kanban/incoming/<branch>`
// at the moment the session ends. When the worker could not push (host outage), the board
// finds no ref, logs "nothing to sync" and closes the session as failed. The worker then
// pushes its retained result on reconnect: the ref lands, and nothing ever looked at it again
// until the NEXT board restart (the startup sweep) -- and then only inside the one-hour
// landable window. Finished work stayed invisible: no review, no merge, a re-run from scratch.
//
// This is the live half: the git transport calls `deliverLateResult` after every successful
// receive-pack into the incoming namespace. It acts ONLY when the workspace on that branch has
// no running session (a live session lands its own result at exit), and it goes through
// `syncIncomingBranch` -- the one landing path, fast-forward only. A divergence is HELD and
// recorded, never forced.

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { findLiveWorkspacesOnBranch } from "../repositories/workspace-reads.repository.js";
import { getRunningSessionIdsForWorkspace } from "../repositories/workspace-lifecycle-reconcile.repository.js";
import { getWorkerById } from "../repositories/worker.repository.js";
import { syncIncomingBranch, clearIncomingRef } from "./worker-remote-sync.service.js";
import { recordWorkerEvent } from "./worker-events.service.js";

export type LateDeliveryOutcome =
  | { delivered: true; workspaceId: string; note: string }
  | { delivered: false; reason: string; held?: boolean };

/** The timeline wording the ticket asks for. */
export function lateResultNote(workerName: string): string {
  return `late result delivered by ${workerName}`;
}

export async function deliverLateResult(
  params: { projectId: string; repoPath: string; branch: string; workerId: string },
  database: Database = realDb,
): Promise<LateDeliveryOutcome> {
  const { repoPath, branch, workerId } = params;
  const candidates = await findLiveWorkspacesOnBranch(branch, database);
  if (candidates.length === 0) return { delivered: false, reason: "no open workspace on this branch" };

  // Any live session means the normal exit path will land this push itself.
  for (const ws of candidates) {
    if ((await getRunningSessionIdsForWorkspace(ws.id, database)).length > 0) {
      return { delivered: false, reason: "a session is still running; it lands its own result at exit" };
    }
  }
  const workspace = candidates[0]!;

  const sync = await syncIncomingBranch(repoPath, branch, workspace.workingDir ? { worktreePath: workspace.workingDir } : undefined);
  if (!sync.ok) {
    const reason = `late result for ${branch} could not be landed (${sync.status}): ${sync.error}`;
    console.warn(`[late-result] ${reason}; held in the incoming ref for an operator`);
    void recordWorkerEvent({
      database,
      workerId,
      type: "ref_held",
      summary: reason,
      payload: { projectId: params.projectId, branch, workspaceId: workspace.id, late: true },
    });
    return { delivered: false, reason, held: true };
  }
  await clearIncomingRef(repoPath, branch).catch(() => {});

  const worker = await getWorkerById(workerId, database).catch(() => null);
  const note = lateResultNote(worker?.name ?? workerId);
  console.log(`[late-result] ${note} for ${branch} (${sync.status} via ${sync.via ?? "ref"})`);
  void recordWorkerEvent({
    database,
    workerId,
    type: "ref_landed",
    summary: `${note}: ${branch}`,
    payload: { projectId: params.projectId, branch, workspaceId: workspace.id, late: true, status: sync.status },
  });
  return { delivered: true, workspaceId: workspace.id, note };
}
