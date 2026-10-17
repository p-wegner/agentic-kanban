/**
 * #1556 — a builder exit that carries NEW commits supersedes the merge backoff recorded against the
 * old tip. `shouldSkipMergeForBackoff` already clears a block when the branch gained real work, but
 * it only runs for merge CANDIDATES; a follow-up turn drops `readyForMerge` (#1545), so the fixed
 * branch was never a candidate and the stale `blocked:true, branchSha:<old>` row sat there for ever.
 * Under `sprint` nothing re-armed the flag either (no review session to do it), so the branch also
 * has to be re-marked for the merge queue to gate it again.
 */
import type { Database } from "../../db/index.js";
import { getMergeBackoffState } from "../../repositories/merge-backoff.repository.js";
import { setWorkspaceReadyForMerge } from "../../repositories/workspace-crud.repository.js";
import { stampWorkspaceReadyForMergeAt } from "../../repositories/workspace-ready-for-merge.repository.js";
import { clearMergeBackoff, defaultBranchHeadSha, defaultHasSubstantiveChangeSince, type MergeBackoffDeps } from "../../services/merge-backoff.service.js";

export async function supersedeStaleMergeBackoff(
  ws: { id: string; projectId: string; workingDir: string | null },
  database: Database,
  deps: MergeBackoffDeps = {},
): Promise<boolean> {
  try {
    const row = await getMergeBackoffState(ws.id, database);
    if (!row?.failures || !row.branchSha || !ws.workingDir) return false;
    // Not `shouldSkipMergeForBackoff`: that returns early once nextRetryAt has passed, leaving the stale row.
    const head = await (deps.getBranchHeadSha ?? defaultBranchHeadSha)(ws.workingDir);
    if (!head || head === row.branchSha) return false;
    const substantive = await (deps.hasSubstantiveChangeSince ?? defaultHasSubstantiveChangeSince)(ws.workingDir, row.branchSha);
    if (substantive === false) return false;
    await clearMergeBackoff(database, ws.id);
    return true;
  } catch (err) {
    console.warn(`[workflow] could not supersede merge backoff for ${ws.id}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Re-mark a fixed branch for the merge queue when no review session will (sprint). Gate evidence stays unset: the queue re-gates. */
export async function rearmReadyForMerge(workspaceId: string, now: string, database: Database): Promise<void> {
  await setWorkspaceReadyForMerge(workspaceId, now, database);
  await stampWorkspaceReadyForMergeAt(workspaceId, now, database);
}
