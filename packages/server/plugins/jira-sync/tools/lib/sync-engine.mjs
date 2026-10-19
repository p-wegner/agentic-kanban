// The pull half of Jira Sync (#1078): fetch every Jira issue matching `jql`, map each
// through the declared field map (field-map.mjs), and idempotently create/update board
// issues keyed by `externalKey` (the Jira issue key). Never deletes — a Jira issue this
// project previously synced but that has since moved out of `jql`'s scope is reported
// in `reportedOutOfScope`, not removed from the board. A board issue that changed since
// our own last write is reported as `conflicted` rather than silently overwritten.

import { FIELDS, mapJiraIssueToBoardFields, resolveBoardStatusId } from "./field-map.mjs";
import { hasAttributionMarker } from "./comment-marker.mjs";
import { boardFieldsOf, fieldsEqual, incomingFieldsOf } from "./field-snapshot.mjs";

// Markers (#1624) for board issues whose Jira twin vanished. Each also carries the
// board's own `no-auto-start` tag so the unchanged autostart engines skip the issue.
export const DELETED_TAG = "jira:deleted";
export const OUT_OF_SCOPE_TAG = "jira:out-of-scope";
const NO_AUTO_START_TAG = "no-auto-start";

/**
 * @param {import("./jira-client.mjs").JiraClient} client
 * @param {import("./board-client.mjs").BoardClient} boardClient
 * @param {{
 *   jql: string,
 *   siteUrl?: string,
 *   projectId: string,
 *   knownState: { issues: Record<string, { updated: string, boardIssueId?: string, boardUpdatedAt?: string }> },
 *   dryRun?: boolean,
 *   pendingWritebackKeys?: Set<string>, // keys push created whose board writeback has not landed yet
 *   deletedStatusName?: string,
 * }} opts
 */
export async function runInboundSync(
  client,
  boardClient,
  { jql, siteUrl, projectId, knownState, dryRun = false, pendingWritebackKeys = new Set(), deletedStatusName = "Cancelled" },
) {
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
  let commentsImported = 0;

  for await (const jiraIssue of client.searchAll(jql, { fields: FIELDS })) {
    seenKeys.add(jiraIssue.key);
    const mapped = mapJiraIssueToBoardFields(jiraIssue, { siteUrl });
    const known = knownState.issues[jiraIssue.key];
    const boardIssue = boardIssuesByKey.get(jiraIssue.key);

    if (!boardIssue && pendingWritebackKeys.has(jiraIssue.key)) {
      // push created this Jira issue from a board issue whose externalKey writeback is still
      // pending: importing it now would duplicate that board issue (#1623).
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "pending writeback to an existing board issue" });
      continue;
    }

    if (!boardIssue) {
      if (!dryRun) {
        const statusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
        const created_ = await boardClient.createIssue({
          projectId,
          title: mapped.title,
          description: mapped.description ?? undefined,
          priority: mapped.priority,
          issueType: mapped.type,
          statusId: statusId ?? undefined,
          externalKey: mapped.externalKey,
          externalUrl: mapped.externalUrl,
        });
        await attachMissingTags(boardClient, tagCache, created_.id, mapped.tags, []);
        const imported = await importComments(boardClient, created_.id, mapped.comments, known?.commentIds);
        commentsImported += imported.count;
        nextState.issues[jiraIssue.key] = {
          updated: mapped.jiraUpdated,
          boardIssueId: created_.id,
          boardUpdatedAt: created_.updatedAt,
          fields: incomingFieldsOf(mapped, statusId),
          commentIds: imported.commentIds,
        };
      } else {
        commentsImported += newComments(mapped.comments, known?.commentIds).length;
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
    // No `known` entry at all (lost/reset state file, or externalKey set by another
    // path e.g. outbound sync) means we have no baseline to prove it's safe to
    // overwrite either, so that also counts as locally edited rather than a blind write.
    //
    // #1635: `updatedAt` alone also moves for unmapped edits and never settles once both sides
    // agree, so a moved timestamp is only a conflict when the MAPPED fields really diverge:
    // unchanged against the last-synced snapshot -> safe to update; equal to what Jira now says
    // -> converged, resolve it and re-baseline; otherwise a real conflict.
    const timestampMoved = known == null || boardIssue.updatedAt !== known.boardUpdatedAt;
    const currentFields = boardFieldsOf(boardIssue);
    const incomingStatusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
    const incomingFields = incomingFieldsOf(mapped, incomingStatusId);
    const boardUnchanged = known?.fields != null && fieldsEqual(currentFields, known.fields);
    const converged = fieldsEqual(currentFields, incomingFields);
    if (timestampMoved && !boardUnchanged && converged) {
      if (!dryRun) {
        const imported = await importComments(boardClient, boardIssue.id, mapped.comments, known?.commentIds);
        commentsImported += imported.count;
        nextState.issues[jiraIssue.key] = {
          ...known,
          updated: mapped.jiraUpdated,
          boardIssueId: boardIssue.id,
          boardUpdatedAt: boardIssue.updatedAt,
          fields: currentFields,
          commentIds: imported.commentIds,
        };
      } else {
        commentsImported += newComments(mapped.comments, known?.commentIds).length;
      }
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "board and Jira already agree; conflict resolved" });
      continue;
    }
    const locallyEdited = timestampMoved && !boardUnchanged;
    if (locallyEdited) {
      // Comments are append-only on the board, so importing them can't clobber local edits.
      if (!dryRun) {
        const imported = await importComments(boardClient, boardIssue.id, mapped.comments, known?.commentIds);
        commentsImported += imported.count;
        if (known) nextState.issues[jiraIssue.key] = { ...known, commentIds: imported.commentIds };
      } else {
        commentsImported += newComments(mapped.comments, known?.commentIds).length;
      }
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
        issueType: mapped.type,
        statusId: statusId ?? undefined,
      });
      const existingTags = await boardClient.listIssueTags(boardIssue.id);
      await attachMissingTags(boardClient, tagCache, boardIssue.id, mapped.tags, existingTags);
      const imported = await importComments(boardClient, boardIssue.id, mapped.comments, known?.commentIds);
      commentsImported += imported.count;
      nextState.issues[jiraIssue.key] = {
        updated: mapped.jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt: updated_.updatedAt,
        fields: incomingFieldsOf(mapped, statusId),
        commentIds: imported.commentIds,
      };
    } else {
      commentsImported += newComments(mapped.comments, known?.commentIds).length;
    }
    updated++;
    details.push({ key: jiraIssue.key, action: "update" });
  }

  // Deletions/moves out of JQL scope: a key we've synced before but did not see this
  // run. Never hard-deleted from the board (#1078); since #1624 each is classified
  // (deleted = `GET issue` 404, otherwise out of scope), marked with a tag, and a
  // deleted one is moved out of the startable columns.
  const reportedOutOfScope = Object.keys(knownState.issues).filter((key) => !seenKeys.has(key));
  const outOfScope = [];
  const deletedStatus = boardStatuses.find((st) => st.name.toLowerCase() === String(deletedStatusName).toLowerCase());
  for (const key of reportedOutOfScope) {
    const reason = await classifyMissingIssue(client, key);
    const entry = { key, reason };
    outOfScope.push(entry);
    const boardIssue = boardIssuesByKey.get(key);
    if (!boardIssue || reason === "unknown" || dryRun) continue;
    const tag = reason === "deleted" ? DELETED_TAG : OUT_OF_SCOPE_TAG;
    const existingTags = await boardClient.listIssueTags(boardIssue.id);
    await attachMissingTags(boardClient, tagCache, boardIssue.id, [tag, NO_AUTO_START_TAG], existingTags);
    if (reason === "deleted" && deletedStatus && boardIssue.statusId !== deletedStatus.id) {
      const moved = await boardClient.updateIssue(boardIssue.id, { statusId: deletedStatus.id });
      entry.movedTo = deletedStatus.name;
      const prior = nextState.issues[key];
      if (prior) nextState.issues[key] = { ...prior, boardUpdatedAt: moved.updatedAt };
    }
  }

  return {
    jql,
    total: details.length,
    created,
    updated,
    skipped,
    conflicted,
    commentsImported,
    reportedOutOfScope,
    outOfScope,
    details,
    nextState,
  };
}

/** `deleted` (Jira answers 404), `out-of-scope` (still exists), or `unknown` (lookup failed). */
async function classifyMissingIssue(client, key) {
  try {
    await client.getIssue(key, { fields: ["summary"] });
    return "out-of-scope";
  } catch (err) {
    return err?.status === 404 ? "deleted" : "unknown";
  }
}

function newComments(comments, importedIds = []) {
  const seen = new Set(importedIds);
  return comments.filter((c) => !seen.has(c.id) && !hasAttributionMarker(c.body));
}

/**
 * Pulls Jira comments onto the board issue: attributed, de-duplicated (by Jira comment
 * id, held in sync state AND in each imported comment's payload so a lost state file
 * can't double-import), and skipping comments that carry the push marker.
 */
async function importComments(boardClient, issueId, comments, importedIds = []) {
  const commentIds = new Set(importedIds);
  const existing = await boardClient.listComments(issueId);
  for (const c of existing) {
    if (c.payload?.jiraCommentId) commentIds.add(String(c.payload.jiraCommentId));
  }
  let count = 0;
  for (const comment of comments) {
    if (commentIds.has(comment.id)) continue;
    commentIds.add(comment.id); // marker-carrying echoes are recorded too, never imported
    if (hasAttributionMarker(comment.body)) continue;
    const when = comment.created ? ` (${comment.created})` : "";
    await boardClient.addComment(issueId, {
      kind: "note",
      author: "system",
      body: `**Jira comment by ${comment.author}${when}:**\n\n${comment.body}`,
      payload: { origin: "jira", jiraCommentId: comment.id },
    });
    count++;
  }
  return { count, commentIds: [...commentIds] };
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
