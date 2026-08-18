// Repo-aware ticket authoring (#94): apply the `repo:<name>` tags that mark which repos
// an issue touches. Auto-creates the tag on first use (global tag system — no schema
// migration) and links it to the issue idempotently. Shared by the create-issue path
// (issue.service) and epic decomposition (issue-ai.service), so the tag color/naming
// stays consistent and the "ensure exists then link" logic lives in one place.
import { randomUUID } from "node:crypto";
import { repoTagName, repoNameFromTag, resolveRepoName, REPO_TAG_COLOR } from "@agentic-kanban/shared/lib/repo-tags";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getTagByName, insertTag, getIssueTagLink, insertIssueTag } from "../repositories/issue-ai.repository.js";
import { issueTags, tags } from "@agentic-kanban/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getProjectRepoNames } from "../repositories/repo.repository.js";

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

/**
 * The repos an issue declares it touches, read back from its `repo:<name>` tags (#629).
 *
 * The write half (`applyRepoTags`) has existed since #94 and `POST /api/issues` accepts
 * `reposTouched` — but nothing ever READ it back, so workspace creation defaulted to "all
 * repos" for every ticket. On a 17-repo project that meant 17 worktrees and 17 dependency
 * installs for a ticket whose work was entirely in one repo.
 *
 * Returns bare repo names in tag order. Never throws: this feeds a DEFAULT, and a scope
 * decision that fails closed on an unreadable tag table would be worse than the old
 * behaviour, not better.
 */
export async function getIssueReposTouched(
  issueId: string,
  database: Database = db,
): Promise<string[]> {
  try {
    const rows = await database
      .select({ name: tags.name })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(eq(issueTags.issueId, issueId));
    return rows.map((r) => repoNameFromTag(r.name)).filter((r): r is string => Boolean(r));
  } catch {
    return [];
  }
}

/**
 * SET an issue's `repo:<name>` tags to exactly `repoNames` (#633).
 *
 * The create path could apply these; nothing could ever change them, because
 * `ReposTouchedField` was rendered in exactly ONE place (`CreateIssuePanel`). Any issue
 * created another way — and on `comet` that was all nine of them, filed by plugin loops
 * through `POST /api/issues` — had no repo scope and no way to acquire one short of knowing
 * the tags are spelled `repo:<name>` and hand-typing them into the Tags dropdown.
 *
 * Additive-plus-subtractive, unlike {@link applyRepoTags}: deselecting a repo has to actually
 * remove the tag, or the field would be a one-way ratchet. Only `repo:` tags are touched —
 * an issue's ordinary tags are never disturbed. Names are validated against the project's
 * real repos (`resolveRepoName`, which also canonicalizes spelling), so a stale client cannot
 * mint junk scopes that later read as "this ticket touches a repo that does not exist".
 *
 * @returns the canonical names actually applied.
 */
export async function setIssueReposTouched(
  issueId: string,
  projectId: string,
  repoNames: string[],
  database: Database = db,
): Promise<string[]> {
  const knownRepos = await getProjectRepoNames(projectId, database);
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const raw of repoNames) {
    const canonical = resolveRepoName(raw, knownRepos);
    if (!canonical || seen.has(canonical.toLowerCase())) continue;
    seen.add(canonical.toLowerCase());
    valid.push(canonical);
  }

  // Remove the repo tags that are no longer selected. Scoped to THIS issue's links and to
  // `repo:` tags only — a plain `removeIssueTagsByTagIds` would unlink the tag from every
  // issue that shares it, since repo tags are global rows.
  const current = await database
    .select({ tagId: tags.id, name: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(eq(issueTags.issueId, issueId));
  const wanted = new Set(valid.map((r) => repoTagName(r)));
  const staleIds = current.filter((t) => repoNameFromTag(t.name) && !wanted.has(t.name)).map((t) => t.tagId);
  if (staleIds.length > 0) {
    await database.delete(issueTags).where(and(eq(issueTags.issueId, issueId), inArray(issueTags.tagId, staleIds)));
  }

  if (valid.length > 0) await applyRepoTags(issueId, valid, database);
  return valid;
}
