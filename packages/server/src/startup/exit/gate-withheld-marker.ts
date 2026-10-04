/**
 * The review-exit gate's red verdict, remembered per branch head (#1299).
 *
 * The review-exit handler withholds `readyForMerge` when its pre-merge gate is red, and until now
 * that left no trace the #932 stranded-review reconciler could read: it saw "review exited clean,
 * never armed" and armed the workspace seconds later, so auto-merge re-gated the same red commit.
 * The verdict is persisted as a `gate-decision` comment carrying the head it judged; the
 * reconciler declines to arm while the current head is that head. A new commit is a new head, so
 * the builder's fix is eligible again with nothing to clear.
 */
import type { Database } from "../../db/index.js";
import { insertIssueComment, listWorkspaceCommentPayloadsByKind } from "../../repositories/issue-comments.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export const REVIEW_EXIT_GATE_RED_REASON = "review_exit_gate_red";

interface RevParser {
  revParse(workingDir: string, ref: string): Promise<string>;
}

/** Record that the review-exit gate withheld `readyForMerge` for the workspace's current head. Never throws. */
export async function markReviewExitGateWithheld(
  input: { workspaceId: string; issueId: string; workingDir: string | null; message: string; now?: string },
  deps: { database: Database; gitService: RevParser },
): Promise<void> {
  try {
    if (!input.workingDir) return;
    const headSha = (await deps.gitService.revParse(input.workingDir, "HEAD")).trim();
    await insertIssueComment({
      issueId: input.issueId,
      workspaceId: input.workspaceId,
      kind: "gate-decision",
      author: "system",
      body: `Pre-merge gate withheld readyForMerge at ${headSha.slice(0, 8)}: ${input.message.slice(0, 500)}`,
      payload: { mergeReason: REVIEW_EXIT_GATE_RED_REASON, headSha },
      createdAt: input.now,
    }, deps.database);
  } catch (err) {
    console.warn(`[workflow] could not record the withheld gate verdict for workspace ${input.workspaceId}: ${errorMessage(err)}`);
  }
}

/**
 * Is the newest recorded gate verdict for this workspace a red one for exactly `headSha`?
 * Fail-open on a read error (false): the reconciler's old behaviour, and the merge still gates.
 */
export async function isGateWithheldForHead(database: Database, workspaceId: string, headSha: string): Promise<boolean> {
  try {
    for (const raw of await listWorkspaceCommentPayloadsByKind(workspaceId, "gate-decision", database)) {
      const payload = raw ? (JSON.parse(raw) as { mergeReason?: string; headSha?: string }) : null;
      if (payload?.mergeReason !== REVIEW_EXIT_GATE_RED_REASON) continue;
      return payload.headSha === headSha;
    }
    return false;
  } catch {
    return false;
  }
}
