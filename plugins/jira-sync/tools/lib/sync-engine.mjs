// The pull half of Jira Sync (#1078): fetch every Jira issue matching `jql`, map each
// through the declared field map (field-map.mjs), and idempotently create/update board
// issues keyed by `externalKey` (the Jira issue key). Never deletes — a Jira issue this
// project previously synced but that has since moved out of `jql`'s scope is reported
// in `reportedOutOfScope`, not removed from the board. A board issue that changed since
// our own last write is reported as `conflicted` rather than silently overwritten.

import { FIELDS, mapJiraIssueToBoardFields, resolveBoardStatusId } from "./field-map.mjs";

/**
 * @param {import("./jira-client.mjs").JiraClient} client
 * @param {import("./board-client.mjs").BoardClient} boardClient
 * @param {{
 *   jql: string,
 *   siteUrl?: string,
 *   projectId: string,
 *   knownState: { issues: Record<string, { updated: string, boardIssueId?: string, boardUpdatedAt?: string }> },
 *   dryRun?: boolean,
 * }} opts
 */
export async function runInboundSync(client, boardClient, { jql, siteUrl, projectId, knownState, dryRun = false }) {
  // dryRun only suppresses WRITES (create/update/tag calls below) — these three are
  // reads, and skipping them would make every issue look brand-new (boardIssuesByKey
  // empty), so a dry run could never report skip/update/conflict, only create.
  const boardStatuses = await boardClient.listStatuses(projectId);
  const boardIssuesByKey = await boardClient.listExternallyTrackedIssues(projectId);
  const tagCache = dryRun ? null : new Map((await boardClient.listTags()).map((t) => [t.name.toLowerCase(), t.id]));

  const seenKeys = new Set();
  const details = [];
  const nextState = { issues: { ...knownState.issues } };
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let conflicted = 0;

  for await (const jiraIssue of client.searchAll(jql, { fields: FIELDS })) {
    seenKeys.add(jiraIssue.key);
    const mapped = mapJiraIssueToBoardFields(jiraIssue, { siteUrl });
    const known = knownState.issues[jiraIssue.key];
    const boardIssue = boardIssuesByKey.get(jiraIssue.key);

    if (!boardIssue) {
      if (!dryRun) {
        const statusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
        const created_ = await boardClient.createIssue({
          projectId,
          title: mapped.title,
          description: mapped.description ?? undefined,
          priority: mapped.priority,
          statusId: statusId ?? undefined,
          externalKey: mapped.externalKey,
          externalUrl: mapped.externalUrl,
        });
        await attachMissingTags(boardClient, tagCache, created_.id, mapped.tags, []);
        nextState.issues[jiraIssue.key] = {
          updated: mapped.jiraUpdated,
          boardIssueId: created_.id,
          boardUpdatedAt: created_.updatedAt,
        };
      }
      created++;
      details.push({ key: jiraIssue.key, action: "create" });
      continue;
    }

    if (known && known.updated === mapped.jiraUpdated) {
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "unchanged since the last pull" });
      continue;
    }

    // A board issue that moved since OUR last recorded write means a human (or
    // something else) edited it locally after the last sync — don't clobber that.
    const locallyEdited = known?.boardUpdatedAt != null && boardIssue.updatedAt !== known.boardUpdatedAt;
    if (locallyEdited) {
      conflicted++;
      details.push({ key: jiraIssue.key, action: "conflict", reason: "board issue changed locally since the last sync; not overwritten" });
      continue;
    }

    if (!dryRun) {
      const statusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
      const updated_ = await boardClient.updateIssue(boardIssue.id, {
        title: mapped.title,
        description: mapped.description ?? undefined,
        priority: mapped.priority,
        statusId: statusId ?? undefined,
      });
      const existingTags = await boardClient.listIssueTags(boardIssue.id);
      await attachMissingTags(boardClient, tagCache, boardIssue.id, mapped.tags, existingTags);
      nextState.issues[jiraIssue.key] = {
        updated: mapped.jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt: updated_.updatedAt,
      };
    }
    updated++;
    details.push({ key: jiraIssue.key, action: "update" });
  }

  // Deletions/moves out of JQL scope: a key we've synced before but did not see this
  // run. Reported, never deleted from the board (#1078's explicit requirement).
  const reportedOutOfScope = Object.keys(knownState.issues).filter((key) => !seenKeys.has(key));

  return { jql, total: details.length, created, updated, skipped, conflicted, reportedOutOfScope, details, nextState };
}

/** Ensures each of `tagNames` exists (creating missing ones) and is attached to `issueId`. */
async function attachMissingTags(boardClient, tagCache, issueId, tagNames, existingTags) {
  if (tagNames.length === 0) return;
  const alreadyAttached = new Set(existingTags.map((t) => t.id));
  for (const name of tagNames) {
    const key = name.toLowerCase();
    let tagId = tagCache.get(key);
    if (!tagId) {
      const tag = await boardClient.createTag(name);
      tagId = tag.id;
      tagCache.set(key, tagId);
    }
    if (!alreadyAttached.has(tagId)) {
      await boardClient.attachTag(issueId, tagId);
    }
  }
}
