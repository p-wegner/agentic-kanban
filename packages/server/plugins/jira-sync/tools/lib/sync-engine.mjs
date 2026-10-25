// The pull half of Jira Sync (#1078): fetch every Jira issue matching `jql`, map each
// through the declared field map (field-map.mjs), and idempotently create/update board
// issues keyed by `externalKey` (the Jira issue key). Never deletes — a Jira issue this
// project previously synced but that has since moved out of `jql`'s scope is reported
// in `reportedOutOfScope`, not removed from the board. A board issue that changed since
// our own last write is reported as `conflicted` rather than silently overwritten.

import { FIELDS, mapJiraIssueToBoardFields, resolveBoardStatusId } from "./field-map.mjs";
import {
  SPRINT_PREFIX,
  VERSION_PREFIX,
  attachmentFooterOf,
  findSprintFieldId,
  hasManagedPrefix,
  parseCustomFieldMap,
  resolveCustomFieldMap,
  stripAttachmentFooter,
  unknownFieldsMessage,
  withAttachmentFooter,
} from "./jira-context.mjs";
import { hasAttributionMarker } from "./comment-marker.mjs";
import { runLinkPull } from "./link-sync.mjs";
import { LEGACY_DIRECTIONS, pullsField, pushesField, withOwners } from "./sync-direction.mjs";
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
 *   assigneeMap?: Jira accountId -> board name (#1702); an unmapped accountId falls back to the displayName
 *   forceKeys?: Set<string>, // keys whose Jira state overwrites the board even when it was edited locally (`sync resolve --keep jira`)
 *   customFieldMap?: string, // raw `customFieldMap` setting (#1701): Jira field -> tag:<prefix>, read-only
 *   now?: string,
 * }} opts
 */
export async function runInboundSync(
  client,
  boardClient,
  { jql, siteUrl, projectId, knownState, dryRun = false, pendingWritebackKeys = new Set(), deletedStatusName = "Cancelled", forceKeys = new Set(), directions = LEGACY_DIRECTIONS, customFieldMap = "", assigneeMap = {}, now = new Date().toISOString() },
) {
  // dryRun only suppresses WRITES (create/update/tag calls below) — these three are
  // reads, and skipping them would make every issue look brand-new (boardIssuesByKey
  // empty), so a dry run could never report skip/update/conflict, only create.
  const boardStatuses = await boardClient.listStatuses(projectId);
  const boardIssuesByKey = await boardClient.listExternallyTrackedIssues(projectId);
  const tagCache = dryRun ? null : new Map((await boardClient.listTags()).map((t) => [t.name.toLowerCase(), t.id]));

  // Read everything Jira says BEFORE writing anything, so a refused run (mass deletion) leaves
  // the board untouched (#1641).
  const context = await resolveJiraContext(client, customFieldMap);
  const mapOpts = { siteUrl, sprintFieldId: context.sprintFieldId, customFields: context.customFields, assigneeMap };
  const jiraIssues = [];
  for await (const jiraIssue of client.searchAll(jql, { fields: context.fields })) jiraIssues.push(jiraIssue);
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
    const mapped = mapJiraIssueToBoardFields(jiraIssue, mapOpts);
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
          description: withAttachmentFooter(mapped.description ?? "", mapped.attachmentFooter) || undefined,
          priority: mapped.priority,
          issueType: mapped.type,
          statusId: statusId ?? undefined,
          externalKey: mapped.externalKey,
          externalUrl: mapped.externalUrl,
        });
        createdIssue = created_;
        await attachMissingTags(boardClient, tagCache, created_.id, [...mapped.tags, ...mapped.contextTags], []);
        const imported = await importComments(boardClient, created_.id, mapped.comments, known?.commentIds);
        commentsImported += imported.count;
        nextState.issues[jiraIssue.key] = {
          updated: mapped.jiraUpdated,
          boardIssueId: created_.id,
          boardUpdatedAt: created_.updatedAt,
          fields: incomingFieldsOf(mapped, statusId),
          assigneeAccountId: mapped.assigneeAccountId,
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
    const OWNABLE = ["title", "description", "priority", "type", "assignee"];
    const jiraOwned = OWNABLE.filter((f) => !pushesField(directions, f));
    const boardOwned = OWNABLE.filter((f) => !pullsField(directions, f));
    const earlyCurrent = boardFieldsOf(boardIssue);
    const earlyJira = incomingFieldsOf(mapped, resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses));
    const ownedEdits = known?.fields ? jiraOwned.filter((f) => known.fields[f] !== undefined && earlyCurrent[f] !== known.fields[f]) : [];
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
    for (const f of OWNABLE) if (!pullsField(directions, f)) incomingFields[f] = currentFields[f];
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
          assigneeAccountId: mapped.assigneeAccountId,
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
        await syncContextTags(boardClient, tagCache, boardIssue.id, mapped.contextTags, context.managedPrefixes);
        // The attachments footer is read-only context too (#1701) and never conflicts: apply it, keep the board's own text (#1719).
        if (attachmentFooterOf(boardIssue.description) !== mapped.attachmentFooter) {
          await boardClient.updateIssue(boardIssue.id, {
            description: withAttachmentFooter(stripAttachmentFooter(boardIssue.description ?? ""), mapped.attachmentFooter) || undefined,
          });
        }
        if (known) nextState.issues[jiraIssue.key] = { ...known, commentIds: imported.commentIds };
      } else {
        commentsImported += newComments(mapped.comments, known?.commentIds).length;
      }
      conflicted++;
      const statusName = (id) => boardStatuses.find((st) => st.id === id)?.name ?? id;
      // #1709: name the ownership case, so the resolver knows the default winner.
      const reason = ownedEdits.length > 0
        ? `${ownedEdits.map((f) => `${f} is jira-to-board: a board edit is not pushed; resolve keep jira, or change the direction`).join("; ")}`
        : "board issue changed locally since the last sync; not overwritten";
      details.push({
        key: jiraIssue.key,
        action: "conflict",
        reason,
        localIssueNumber: boardIssue.issueNumber,
        fields: withOwners(fieldTable(currentFields, known?.fields ?? null, jiraFields, { statusName }), directions),
        ...driftNote,
      });
      continue;
    }

    // Only a real board write counts as an update (#1696): a mapped field pull would change, a status
    // move, a label to attach, or a comment to import.
    const statusId = resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses);
    const writtenDiff = OWNABLE.filter((f) => pullsField(directions, f) && currentFields[f] !== jiraFields[f]);
    // The assignee is a tag, not an issue column: it is applied below with the other tags.
    const columnDiff = writtenDiff.filter((f) => f !== "assignee");
    const assigneeMoves = writtenDiff.includes("assignee");
    const statusMoves = statusId != null && statusId !== boardIssue.statusId;
    // The attachment footer (#1701) is plugin-owned and not a snapshot field: a changed footer is a plain update.
    const footerChanged = attachmentFooterOf(boardIssue.description) !== mapped.attachmentFooter;
    const descriptionWrite = pullsField(directions, "description") ? mapped.description ?? "" : stripAttachmentFooter(boardIssue.description ?? "");
    let boardChanged = columnDiff.length > 0 || statusMoves || footerChanged || assigneeMoves;
    // What changed, named for the run summary (#1718).
    const changes = [];
    if (columnDiff.length > 0) changes.push(`fields ${columnDiff.join(", ")}`);
    if (statusMoves) changes.push("status");
    if (footerChanged) changes.push("attachments footer");
    if (!dryRun) {
      let boardUpdatedAt = boardIssue.updatedAt;
      if (columnDiff.length > 0 || statusMoves || footerChanged) {
        const updated_ = await boardClient.updateIssue(boardIssue.id, {
          ...(pullsField(directions, "title") ? { title: mapped.title } : {}),
          ...(pullsField(directions, "description") || footerChanged ? { description: withAttachmentFooter(descriptionWrite, mapped.attachmentFooter) || undefined } : {}),
          ...(pullsField(directions, "priority") ? { priority: mapped.priority } : {}),
          ...(pullsField(directions, "type") ? { issueType: mapped.type } : {}),
          statusId: statusId ?? undefined,
        });
        boardUpdatedAt = updated_.updatedAt;
      }
      const existingTags = await boardClient.listIssueTags(boardIssue.id);
      // Labels the board owns are not re-imported; the assignee/epic/parent tags are not labels.
      // The assignee tag follows the assignee direction (#1702), not the labels one.
      const tagsToApply = (pullsField(directions, "labels") ? mapped.tags : mapped.tags.filter((t) => /^(epic|parent):/i.test(t))).filter((t) => !/^assignee:/i.test(t));
      if (pullsField(directions, "assignee") && mapped.assignee) tagsToApply.push(`assignee:${mapped.assignee}`);
      const attachedNames = new Set(existingTags.map((t) => String(t.name ?? "").toLowerCase()));
      if (tagsToApply.some((t) => !attachedNames.has(t.toLowerCase()))) {
        boardChanged = true;
        changes.push(`tags +${tagsToApply.filter((t) => !attachedNames.has(t.toLowerCase())).join(", ")}`);
      }
      await attachMissingTags(boardClient, tagCache, boardIssue.id, tagsToApply, existingTags);
      if (await syncContextTags(boardClient, tagCache, boardIssue.id, mapped.contextTags, context.managedPrefixes)) {
        boardChanged = true;
        changes.push(`context ${mapped.contextTags.join(", ") || "cleared"}`);
      }
      if (pullsField(directions, "assignee")) {
        // Reassigned or unassigned in Jira: drop the assignee tags that no longer hold (#1702).
        const wanted = mapped.assignee ? `assignee:${mapped.assignee}`.toLowerCase() : null;
        for (const t of existingTags) {
          const name = String(t.name ?? "").toLowerCase();
          if (/^assignee:/.test(name) && name !== wanted) {
            await boardClient.detachTag(boardIssue.id, t.id);
            boardChanged = true;
            if (!mapped.assignee) changes.push("assignee cleared");
          }
        }
      }
      const imported = await importComments(boardClient, boardIssue.id, mapped.comments, known?.commentIds);
      commentsImported += imported.count;
      if (imported.count > 0) {
        boardChanged = true;
        changes.push(`comments +${imported.count}`);
      }
      nextState.issues[jiraIssue.key] = {
        updated: mapped.jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt,
        // lastSync is what Jira holds, which after this write is also what the board holds for every
        // field pull owns; a board-owned field Jira disagrees on is NOT recorded as agreed (#1696).
        fields: jiraFields,
        assigneeAccountId: mapped.assigneeAccountId,
        commentIds: imported.commentIds,
      };
    } else {
      const fresh = newComments(mapped.comments, known?.commentIds).length;
      commentsImported += fresh;
      if (fresh > 0) {
        boardChanged = true;
        changes.push(`comments +${fresh}`);
      }
      // Reads only: a dry run still names a context-tag change instead of reporting a skip (#1718).
      const have = new Set((await boardClient.listIssueTags(boardIssue.id)).map((t) => String(t.name ?? "").toLowerCase()));
      const addedContext = mapped.contextTags.filter((t) => !have.has(t.toLowerCase()));
      if (addedContext.length > 0) {
        boardChanged = true;
        changes.push(`context ${addedContext.join(", ")}`);
      }
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
      ...(changes.length > 0 ? { changes } : {}),
      ...driftNote,
    });
  }

  // Issue links -> board dependencies (#1700), once every issue of this run has a board id.
  const idByKey = new Map([...boardIssuesByKey].map(([k, i]) => [k, i.id]));
  for (const [k, entry] of Object.entries(nextState.issues)) if (entry.boardIssueId && !entry.deletedAt) idByKey.set(k, entry.boardIssueId);
  const linkResult = await runLinkPull(boardClient, { jiraIssues, idByKey, knownLinks: knownState.links ?? {}, directions, dryRun });
  nextState.links = linkResult.nextLinks;
  // An issue whose only change is a link is not a "skip" (#1718): name the link on the issue's own line.
  const linkChanges = new Map();
  const noteLink = (key, text) => linkChanges.set(key, [...(linkChanges.get(key) ?? []), text]);
  for (const d of linkResult.details) {
    if (d.action === "link-create") {
      noteLink(d.to, d.kind === "blocks" ? `links +1 (blocked by ${d.from})` : `links +1 (related to ${d.from})`);
      if (d.kind === "relates") noteLink(d.from, `links +1 (related to ${d.to})`);
      else noteLink(d.from, `links +1 (blocks ${d.to})`);
    } else if (d.action === "link-remove") {
      noteLink(d.to, `links -1 (${d.kind} ${d.from})`);
      noteLink(d.from, `links -1 (${d.kind} ${d.to})`);
    }
  }
  for (const [key, texts] of linkChanges) {
    const entry = details.find((x) => x.key === key && (x.action === "skip" || x.action === "update"));
    if (!entry) continue;
    if (entry.action === "skip") {
      entry.action = "update";
      delete entry.reason;
      skipped--;
      updated++;
    }
    entry.changes = [...(entry.changes ?? []), ...texts];
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
    links: {
      created: linkResult.created,
      removed: linkResult.removed,
      skipped: linkResult.skipped,
      unsupported: linkResult.unsupported,
      conflicted: linkResult.conflicted,
      details: linkResult.details,
    },
    linkSnapshotAdjust: linkResult.snapshotAdjust,
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

/**
 * Read-only Jira context (#1701): the sprint field id (found via `GET /field`, never hard-coded), the
 * resolved custom-field map, every Jira field a pull must fetch, and the tag prefixes this plugin owns.
 * A bad or unknown `customFieldMap` row aborts the pull before anything is written, naming the field.
 */
export async function resolveJiraContext(client, customFieldMap = "") {
  const parsed = parseCustomFieldMap(customFieldMap);
  if (parsed.error) throw Object.assign(new Error(parsed.error), { code: "BAD_CONFIG" });
  let catalog = [];
  if (typeof client.listFields === "function") {
    try {
      catalog = (await client.listFields()) ?? [];
    } catch (err) {
      // Without the catalog only the sprint tags are lost; a configured map cannot be resolved at all.
      if (parsed.rows.length > 0) throw err;
    }
  } else if (parsed.rows.length > 0) {
    throw Object.assign(new Error("customFieldMap: the Jira client cannot list fields"), { code: "BAD_CONFIG" });
  }
  const { resolved, unknown } = resolveCustomFieldMap(parsed.rows, catalog);
  const message = unknownFieldsMessage(unknown);
  if (message) throw Object.assign(new Error(message), { code: "BAD_CONFIG" });
  const sprintFieldId = findSprintFieldId(catalog);
  return {
    sprintFieldId,
    customFields: resolved,
    fields: [...new Set([...FIELDS, ...(sprintFieldId ? [sprintFieldId] : []), ...resolved.map((r) => r.id)])],
    managedPrefixes: [VERSION_PREFIX, ...(sprintFieldId ? [SPRINT_PREFIX] : []), ...resolved.map((r) => r.prefix)],
  };
}

/** Attaches the wanted context tags and detaches stale ones of a managed prefix (a changed sprint replaces the old tag). Returns whether anything changed. */
async function syncContextTags(boardClient, tagCache, issueId, wanted, managedPrefixes) {
  const existing = await boardClient.listIssueTags(issueId);
  const have = new Set(existing.map((t) => String(t.name ?? "").toLowerCase()));
  const want = new Set(wanted.map((t) => t.toLowerCase()));
  const stale = existing.filter((t) => hasManagedPrefix(t.name, managedPrefixes) && !want.has(String(t.name).toLowerCase()));
  const missing = wanted.filter((t) => !have.has(t.toLowerCase()));
  for (const tag of stale) await boardClient.detachTag(issueId, tag.id);
  await attachMissingTags(boardClient, tagCache, issueId, missing, existing);
  return stale.length > 0 || missing.length > 0;
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
