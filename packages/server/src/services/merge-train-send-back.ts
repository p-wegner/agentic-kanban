/**
 * The send-back half of a base-conflict drop (live gap 2026-09-27, #1253/#1261).
 *
 * `assembleMergeTrain` drops a member whose branch no longer merges onto the base. The ladder
 * promised such a member "goes back for a rebase", and `merge-train-siding.service.ts` (#1192)
 * does record the siding and nudge the builder. Observed live, though, the member stayed `idle` +
 * `readyForMerge`, the next window picked it again and dropped it again, train after train,
 * until a human relaunched its builder. Two reasons: the nudge ran only after the WHOLE train
 * finished (gate plus bisect, 30+ minutes), and not at all when the train job died or the
 * reconciler took it over; and nothing took the member out of the ready set in the meantime.
 *
 * These helpers are what a send-back does beyond the siding record: take the member out of the
 * ready set with a visible reason, hand the builder one concrete instruction, and, once the cap
 * is burned, put a merge hold on it so a human sees it instead of the train looping.
 *
 * Pure prompt/parsing plus best-effort DB writes; nothing here spawns git or a session.
 */
import type { Database } from "../db/index.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { setMergeHold } from "../repositories/merge-hold.repository.js";
import { setWorkspaceReadyForMerge } from "../repositories/workspace-crud.repository.js";
import { clearWorkspaceReadyForMerge } from "../repositories/workspace-merge-prevalidation.repository.js";

/** Every merge hold this module places starts with this, so an operator can tell who placed it. */
export const TRAIN_SEND_BACK_HOLD_MARKER = "merge train:";

/** The files a `Merge conflict in: a, b` drop reason names (`git-service/merge.ts`); empty when it names none. */
export function conflictFilesFromReason(reason: string): string[] {
  const match = /Merge conflict in:\s*(.+)$/m.exec(reason);
  if (!match) return [];
  return match[1].split(",").map((f) => f.trim()).filter(Boolean);
}

/**
 * The ONE follow-up a base-conflict drop sends the builder, whether as a `/turn` to a live
 * session or as a fresh launch. It names the rebase itself (not the board's `update-base`, which
 * an agent cannot call), because a fresh session starts on a clean, un-rebased tree: without the
 * explicit rebase it finds nothing to resolve (the #1209 failure).
 */
export function formatBaseConflictSendBackPrompt(args: {
  branch: string;
  baseBranch: string;
  trainRef: string;
  reason: string;
}): string {
  const files = conflictFilesFromReason(args.reason);
  const fileList = files.length > 0
    ? files.map((f) => `- ${f}`).join("\n")
    : `(git did not name them: ${args.reason.slice(0, 300)})`;
  return (
    `The merge train dropped this branch (${args.branch}) from ${args.trainRef}: it no longer merges cleanly ` +
    `onto the local '${args.baseBranch}', which moved since you finished. The train will not rewrite your branch, ` +
    `so it is back with you for one rebase.\n\n` +
    `Conflicting files:\n${fileList}\n\n` +
    `1. Rebase onto the LOCAL base: \`git rebase ${args.baseBranch}\` (not origin/${args.baseBranch}).\n` +
    `2. Resolve each conflict keeping the intent of BOTH sides: what '${args.baseBranch}' changed there is ` +
    `already merged work and must survive, and so must this ticket's change.\n` +
    `3. \`git add\` the resolved files and \`git rebase --continue\` until the rebase is done.\n` +
    `4. Run the tests that cover the files you touched (and typecheck), and fix what the rebase broke.\n` +
    `5. Commit. Do not push and do not merge: when this session ends the board reviews the branch and puts ` +
    `it back in the merge queue for a later train.`
  );
}

/**
 * Take the member out of the ready set while its builder rebases, with a visible reason.
 *
 * The `merge-attempt` comment is also what keeps the stranded-review reconciler (#932) from
 * re-arming `readyForMerge` on its own: it re-arms only a clean review with NO merge-attempt row.
 * The normal exit path (review, then the review-exit gate) re-arms it once the rebase is done.
 */
export async function withholdForSendBack(args: {
  workspaceId: string;
  issueId: string;
  branch: string;
  trainRef: string;
  reason: string;
  sendBack: number;
  maxSendBacks: number;
  now: string;
  database: Database;
}): Promise<void> {
  await clearWorkspaceReadyForMerge(args.workspaceId, args.now, args.database);
  await insertIssueComment({
    issueId: args.issueId,
    workspaceId: args.workspaceId,
    kind: "merge-attempt",
    author: "system",
    body:
      `The merge train dropped this branch (${args.branch}) from ${args.trainRef} for a conflict with the base, ` +
      `so it is no longer ready for merge: its builder was sent back to rebase (send-back ${args.sendBack} of ` +
      `${args.maxSendBacks}). Review and the review-exit gate put it back in the queue.\n\n` +
      `Conflict: ${args.reason.slice(0, 500)}`,
    payload: { eventType: "train-send-back", trainRef: args.trainRef, sendBack: args.sendBack, files: conflictFilesFromReason(args.reason) },
    createdAt: args.now,
  }, args.database);
}

/** The send-back could not be delivered: put the flag back so the member is where it was before. */
export async function restoreReadyAfterFailedSendBack(workspaceId: string, now: string, database: Database): Promise<void> {
  await setWorkspaceReadyForMerge(workspaceId, now, database);
}

/**
 * The cap is burned: the builder was sent back and the branch still conflicts with the base.
 * A merge hold (#1164) is the board's needs-attention state for one workspace: every merge
 * path, the monitor walk and the UI's hold panel already honour it, and only a human releases
 * it (`DELETE /api/workspaces/:id/merge-hold`), so the train stops re-picking the member.
 */
export async function holdAfterSendBackCap(args: {
  workspaceId: string;
  drops: number;
  reason: string;
  now: string;
  database: Database;
}): Promise<void> {
  await clearWorkspaceReadyForMerge(args.workspaceId, args.now, args.database);
  const files = conflictFilesFromReason(args.reason);
  await setMergeHold(args.workspaceId, {
    reason:
      `${TRAIN_SEND_BACK_HOLD_MARKER} needs attention: dropped ${args.drops} times for a conflict with the base, ` +
      `automatic send-backs did not resolve it` + (files.length > 0 ? ` (${files.join(", ")})` : "") +
      ` - rebase by hand, then release this hold`,
    heldAt: args.now,
  }, args.database);
}
