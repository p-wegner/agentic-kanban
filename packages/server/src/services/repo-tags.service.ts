// Repo-aware ticket authoring (#94): apply the `repo:<name>` tags that mark which repos
// an issue touches. Auto-creates the tag on first use (global tag system — no schema
// migration) and links it to the issue idempotently. Shared by the create-issue path
// (issue.service) and epic decomposition (issue-ai.service), so the tag color/naming
// stays consistent and the "ensure exists then link" logic lives in one place.
import { randomUUID } from "node:crypto";
import { repoTagName, REPO_TAG_COLOR } from "@agentic-kanban/shared/lib/repo-tags";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getTagByName, insertTag, getIssueTagLink, insertIssueTag } from "../repositories/issue-ai.repository.js";

/** Ensure a `repo:<name>` tag exists, returning its id. */
async function ensureRepoTag(repoName: string, database: Database): Promise<string> {
  const name = repoTagName(repoName);
  const existing = await getTagByName(name, database);
  if (existing.length > 0) return existing[0].id;
  const id = randomUUID();
  await insertTag({ id, name, color: REPO_TAG_COLOR, isBuiltin: false, createdAt: new Date().toISOString() }, database);
  // A concurrent create could have won the race (insertTag swallows the unique
  // violation); re-read so we link the surviving row rather than a phantom id.
  const after = await getTagByName(name, database);
  return after[0]?.id ?? id;
}

/**
 * Apply `repo:<name>` tags to an issue, creating tags and links as needed. No-op for an
 * empty/blank list. Idempotent — re-applying an already-linked repo does nothing. Blank
 * entries are skipped so a stray "" never yields a `repo:` tag.
 */
export async function applyRepoTags(
  issueId: string,
  repoNames: string[],
  database: Database = db,
): Promise<void> {
  const seen = new Set<string>();
  for (const raw of repoNames) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const tagId = await ensureRepoTag(name, database);
    const link = await getIssueTagLink(issueId, tagId, database);
    if (link.length === 0) {
      await insertIssueTag({ id: randomUUID(), issueId, tagId }, database);
    }
  }
}
