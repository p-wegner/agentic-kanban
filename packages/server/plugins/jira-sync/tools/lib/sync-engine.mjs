// The pull half of Jira Sync (#1078): fetch every Jira issue matching `jql`, map each
// through the declared field map (field-map.mjs), and idempotently create/update board
// issues keyed by `externalKey` (the Jira issue key). Never deletes — a Jira issue this
// project previously synced but that has since moved out of `jql`'s scope is reported
// in `reportedOutOfScope`, not removed from the board. A board issue that changed since
// our own last write is reported as `conflicted` rather than silently overwritten.

import { FIELDS, mapJiraIssueToBoardFields, resolveBoardStatusId } from "./field-map.mjs";
import { hasAttributionMarker } from "./comment-marker.mjs";
import { LEGACY_DIRECTIONS, pullsField, pushesField } from "./sync-direction.mjs";
import { boardFieldsOf, fieldsEqual, incomingFieldsOf, fieldTable } from "./field-snapshot.mjs";

// Markers (#1624) for board issues whose Jira twin vanished. Each also carries the
// board's own `no-auto-start` tag so the unchanged autostart engines skip the issue.
export const DELETED_TAG = "jira:deleted";
export const OUT_OF_SCOPE_TAG = "jira:out-of-scope";
const NO_AUTO_START_TAG = "no-auto-start";

// A pull that would mark more of the known issues deleted than this at once is refused (#1641):
// that shape is a wrong token, a wrong site or a broken JQL, not a real mass deletion.
export const MAX_DELETIONS_PER_PULL = 3;
export const MAX_DELETION_SHARE = 0.2;

export class MassDeletionError extends Error {
  constructor(count, known) {
    super(
      `refusing to apply ${count} deletions out of ${known} known issues at once ` +
        `(limit: ${MAX_DELETIONS_PER_PULL}, or ${MAX_DELETION_SHARE * 100}% of known issues); ` +
        "check the credentials, site URL and JQL. Nothing was written.",
    );
    this.name = "MassDeletionError";
    this.code = "MASS_DELETION";
  }
}

function exceedsDeletionLimit(count, known) {
  return count > MAX_DELETIONS_PER_PULL || (count > 1 && count / known > MAX_DELETION_SHARE);
}

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
 *   directions?: per-field sync direction (#1672); a `board-to-jira` field is never overwritten by pull
 *   forceKeys?: Set<string>, // keys whose Jira state overwrites the board even when it was edited locally (`sync resolve --keep jira`)
 *   now?: string,
 * }} opts
 */
export async function runInboundSync(
  client,
  boardClient,
  { jql, siteUrl, projectId, knownState, dryRun = false, pendingWritebackKeys = new Set(), deletedStatusName = "Cancelled", forceKeys = new Set(), directions = LEGACY_DIRECTIONS, now = new Date().toISOString() },
) {
  // dryRun only suppresses WRITES (create/update/tag calls below) — these three are
  // reads, and skipping them would make every issue look brand-new (boardIssuesByKey
  // empty), so a dry run could never report skip/update/conflict, only create.
  const boardStatuses = await boardClient.listStatuses(projectId);
  const boardIssuesByKey = await boardClient.listExternallyTrackedIssues(projectId);
  const tagCache = dryRun ? null : new Map((await boardClient.listTags()).map((t) => [t.name.toLowerCase(), t.id]));

  // Read everything Jira says BEFORE writing anything, so a refused run (mass deletion) leaves
  // the board untouched (#1641).
  const jiraIssues = [];
  for await (const jiraIssue of client.searchAll(jql, { fields: FIELDS })) jiraIssues.push(jiraIssue);
  const seenKeys = new Set(jiraIssues.map((i) => i.key));
  // Entries already marked deleted are settled; they are only revisited when Jira returns them.
  const activeKnownKeys = Object.keys(knownState.issues).filter((key) => !knownState.issues[key].deletedAt);
  const missingKeys = activeKnownKeys.filter((key) => !seenKeys.has(key));
  const classified = new Map();
  for (const key of missingKeys) classified.set(key, await classifyMissingIssue(client, key));
  const pendingDeletions = [...classified.values()].filter((r) => r === "deleted").length;
  if (exceedsDeletionLimit(pendingDeletions, activeKnownKeys.length)) {
    throw new MassDeletionError(pendingDeletions, activeKnownKeys.length);
  }

  const details = [];
  const nextState = { issues: { ...knownState.issues } };
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let conflicted = 0;
  let commentsImported = 0;

  const restored = [];
  for (const jiraIssue of jiraIssues) {
    const mapped = mapJiraIssueToBoardFields(jiraIssue, { siteUrl });
    let known = knownState.issues[jiraIssue.key];
    let boardIssue = boardIssuesByKey.get(jiraIssue.key);

    // Jira returns an issue we marked deleted: undo the marking (tags, status) and carry on as a
    // normal pull of a settled issue, not a conflict (#1641).
    if (known?.deletedAt) {
      const recovered = await recoverReappeared(boardClient, tagCache, boardIssue, known, boardStatuses, dryRun);
      boardIssue = recovered.boardIssue ?? boardIssue;
      known = recovered.known;
      restored.push(jiraIssue.key);
      if (!dryRun) nextState.issues[jiraIssue.key] = known;
    }

    if (!boardIssue && pendingWritebackKeys.has(jiraIssue.key)) {
      // push created this Jira issue from a board issue whose externalKey writeback is still
      // pending: importing it now would duplicate that board issue (#1623).
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "pending writeback to an existing board issue" });
      continue;
    }

    if (!boardIssue) {
      let createdIssue;
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
        createdIssue = created_;
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
      details.push({ key: jiraIssue.key, action: "create", localIssueNumber: createdIssue?.issueNumber });
      continue;
    }

    // Ownership (#1696). A board edit to a `jira-to-board` field is never silent drift: it is reported as a
    // conflict on every pull until resolved, whether or not Jira changed in between. A `board-to-jira`
    // field is the board's: where Jira differs, the pull records WHAT Jira holds (`jiraDiffers`) so the
    // next push sends the board value back, and lastSync never stores a value Jira does not hold.
    const OWNABLE = ["title", "description", "priority", "type"];
    const jiraOwned = OWNABLE.filter((f) => !pushesField(directions, f));
    const boardOwned = OWNABLE.filter((f) => !pullsField(directions, f));
    const earlyCurrent = boardFieldsOf(boardIssue);
    const earlyJira = incomingFieldsOf(mapped, resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses));
    const ownedEdits = known?.fields ? jiraOwned.filter((f) => earlyCurrent[f] !== known.fields[f]) : [];
    const jiraDiffers = Object.fromEntries(boardOwned.filter((f) => earlyCurrent[f] !== earlyJira[f]).map((f) => [f, earlyJira[f]]));
    const driftNote = Object.keys(jiraDiffers).length > 0 ? { jiraDiffers } : {};

    if (known && known.updated === mapped.jiraUpdated && !forceKeys.has(jiraIssue.key) && ownedEdits.length === 0) {
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "unchanged since the last pull", localIssueNumber: boardIssue.issueNumber, ...driftNote });
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
    const jiraFields = incomingFieldsOf(mapped, incomingStatusId);
    // A field the board owns (#1672) is not Jira's to change: compare as if Jira agreed with the board,
    // so a board edit to it is neither a conflict nor overwritten. The conflict view still shows Jira's value.
    const incomingFields = { ...jiraFields };
    for (const f of ["title", "description", "priority", "type"]) if (!pullsField(directions, f)) incomingFields[f] = currentFields[f];
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
          fields: { ...currentFields, ...jiraDiffers },
          commentIds: imported.commentIds,
        };
      } else {
        commentsImported += newComments(mapped.comments, known?.commentIds).length;
      }
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "board and Jira already agree; conflict resolved", ...driftNote });
      continue;
    }
    const locallyEdited = timestampMoved && !boardUnchanged && !forceKeys.has(jiraIssue.key);
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
      const statusName = (id) => boardStatuses.find((st) => st.id === id)?.name ?? id;
      details.push({
        key: jiraIssue.key,
        action: "conflict",
        reason: "board issue changed locally since the last sync; not overwritten",
        localIssueNumber: boardIssue.issueNumber,
        fields: fieldTable(currentFields, known?.fields ?? null, jiraFields, { statusName }),
        ...driftNote,
      });
      continue;
    }

    // Only a real board write counts as an update (#1696): a mapped field pull would change, a status
    // move, a label to attach, or a comment to import.
    const statusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
    const writtenDiff = OWNABLE.filter((f) => pullsField(directions, f) && currentFields[f] !== jiraFields[f]);
    const statusMoves = statusId != null && statusId !== boardIssue.statusId;
    let boardChanged = writtenDiff.length > 0 || statusMoves;
    if (!dryRun) {
      let boardUpdatedAt = boardIssue.updatedAt;
      if (writtenDiff.length > 0 || statusMoves) {
        const updated_ = await boardClient.updateIssue(boardIssue.id, {
          ...(pullsField(directions, "title") ? { title: mapped.title } : {}),
          ...(pullsField(directions, "description") ? { description: mapped.description ?? undefined } : {}),
          ...(pullsField(directions, "priority") ? { priority: mapped.priority } : {}),
          ...(pullsField(directions, "type") ? { issueType: mapped.type } : {}),
          statusId: statusId ?? undefined,
        });
        boardUpdatedAt = updated_.updatedAt;
      }
      const existingTags = await boardClient.listIssueTags(boardIssue.id);
      // Labels the board owns are not re-imported; the assignee/epic/parent tags are not labels.
      const tagsToApply = pullsField(directions, "labels") ? mapped.tags : mapped.tags.filter((t) => /^(assignee|epic|parent):/i.test(t));
      const attachedNames = new Set(existingTags.map((t) => String(t.name ?? "").toLowerCase()));
      if (tagsToApply.some((t) => !attachedNames.has(t.toLowerCase()))) boardChanged = true;
      await attachMissingTags(boardClient, tagCache, boardIssue.id, tagsToApply, existingTags);
      const imported = await importComments(boardClient, boardIssue.id, mapped.comments, known?.commentIds);
      commentsImported += imported.count;
      if (imported.count > 0) boardChanged = true;
      nextState.issues[jiraIssue.key] = {
        updated: mapped.jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt,
        // lastSync is what Jira holds, which after this write is also what the board holds for every
        // field pull owns; a board-owned field Jira disagrees on is NOT recorded as agreed (#1696).
        fields: jiraFields,
        commentIds: imported.commentIds,
      };
    } else {
      const fresh = newComments(mapped.comments, known?.commentIds).length;
      commentsImported += fresh;
      if (fresh > 0) boardChanged = true;
    }
    if (!boardChanged) {
      skipped++;
      details.push({ key: jiraIssue.key, action: "skip", reason: "no board-side change", localIssueNumber: boardIssue.issueNumber, ...driftNote });
      continue;
    }
    updated++;
    details.push({
      key: jiraIssue.key,
      action: "update",
      localIssueNumber: boardIssue.issueNumber,
      ...driftNote,
    });
  }

  // Deletions/moves out of JQL scope: a key we've synced before but did not see this
  // run. Never hard-deleted from the board (#1078); since #1624 each is classified
  // (deleted = `GET issue` 404, otherwise out of scope), marked with a tag, and a
  // deleted one is moved out of the startable columns.
  const outOfScope = [];
  const deleted = [];
  const deletedStatus = boardStatuses.find((st) => st.name.toLowerCase() === String(deletedStatusName).toLowerCase());
  for (const key of missingKeys) {
    const reason = classified.get(key);
    const boardIssue = boardIssuesByKey.get(key);
    const entry = { key, reason, localIssueNumber: boardIssue?.issueNumber };
    (reason === "deleted" ? deleted : outOfScope).push(entry);
    if (reason === "unknown" || dryRun) continue;
    if (boardIssue) {
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
    // A deletion is applied once: keep the entry (comment ids, baseline) marked `deletedAt` so
    // later pulls do not report it again and a reappearance can be recognised (#1641).
    if (reason === "deleted") {
      const prior = nextState.issues[key];
      nextState.issues[key] = { ...prior, deletedAt: now, preDeleteStatusId: boardIssue?.statusId ?? prior?.preDeleteStatusId, deletedStatusId: deletedStatus?.id };
    }
  }
  for (const entry of deleted) details.push({ key: entry.key, action: "delete", localIssueNumber: entry.localIssueNumber });
  const reportedOutOfScope = outOfScope.map((o) => o.key);

  return {
    jql,
    total: details.length,
    created,
    updated,
    skipped,
    conflicted,
    commentsImported,
    reportedOutOfScope,
    restored,
    outOfScope,
    deleted,
    details,
    nextState,
  };
}

/**
 * Undoes the deleted marking of a board issue whose Jira twin is back: drops the `jira:deleted` and
 * `no-auto-start` tags and, if it still sits in the deleted status, moves it to its pre-delete status.
 * Returns the state entry without the marker, re-baselined against the restored board issue so the
 * regular pull flow sees no local edit.
 */
async function recoverReappeared(boardClient, tagCache, boardIssue, known, boardStatuses, dryRun) {
  const { deletedAt: _deletedAt, preDeleteStatusId, deletedStatusId, ...rest } = known;
  if (!boardIssue) return { boardIssue, known: rest };
  let restored = boardIssue;
  if (!dryRun) {
    const tags = await boardClient.listIssueTags(boardIssue.id);
    for (const tag of tags) {
      if (tag.name === DELETED_TAG || tag.name === NO_AUTO_START_TAG) await boardClient.detachTag(boardIssue.id, tag.id);
    }
    const target = preDeleteStatusId && boardStatuses.find((st) => st.id === preDeleteStatusId);
    const inDeletedStatus = boardIssue.statusId === deletedStatusId;
    if (target && boardIssue.statusId !== target.id && inDeletedStatus) {
      restored = { ...boardIssue, ...(await boardClient.updateIssue(boardIssue.id, { statusId: target.id })) };
    }
  }
  return { boardIssue: restored, known: { ...rest, boardUpdatedAt: restored.updatedAt, fields: boardFieldsOf(restored) } };
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
