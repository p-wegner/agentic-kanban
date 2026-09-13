import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import * as repo from "../repositories/issue-ai.repository.js";

/**
 * The tag that persists a decomposer verdict of "right-sized" (#1134). `decomposeEpic`'s
 * `tooSmallToDecompose` is a TRANSIENT proposal field — with zero children to confirm, the
 * ordinary `/decompose/confirm` path never runs and nothing is written down. Without a
 * persisted signal, "never decomposed" and "deliberately not split" are the same shape (an
 * epic-tagged issue with no children), and a start-eligibility check that treats the epic as
 * work-for-the-decomposer would wrongly re-hold a genuinely right-sized ticket (#1074) rather
 * than a freshly planned, never-decomposed one.
 */
export const TOO_SMALL_TO_DECOMPOSE_TAG = "right-sized";

/**
 * Record the decomposer's "already right-sized, don't split" verdict on the epic itself so it
 * stays startable (#1074) instead of being mistaken for an undecomposed drive epic (#1134).
 * Idempotent: tagging an issue that already carries the tag is a no-op (`insertIssueTag`'s
 * unique index + catch).
 */
export async function markTooSmallToDecompose(
  issueId: string,
  database: Database,
): Promise<void> {
  let tag = await repo.getTagByName(TOO_SMALL_TO_DECOMPOSE_TAG, database);
  if (tag.length === 0) {
    const tagId = randomUUID();
    await repo.insertTag({
      id: tagId,
      name: TOO_SMALL_TO_DECOMPOSE_TAG,
      color: "#0EA5E9",
      isBuiltin: true,
      createdAt: new Date().toISOString(),
    }, database);
    tag = [{ id: tagId }];
  }
  const existing = await repo.getIssueTagLink(issueId, tag[0].id, database);
  if (existing.length === 0) {
    await repo.insertIssueTag({ id: randomUUID(), issueId, tagId: tag[0].id }, database);
  }
}
