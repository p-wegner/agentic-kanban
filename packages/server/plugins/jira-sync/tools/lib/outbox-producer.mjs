// Fills the outbox from board state (#1623). The plugin contract has no board-event
// hook, so push diffs the board against a snapshot of what it saw last time:
//   - a tracked issue (has `externalKey`) whose status changed  -> one transition entry
//   - a new board comment that did not originate in Jira        -> one comment entry
//   - (opt-in) a new issue with no `externalKey`                -> one create entry
//   - (#1672) a tracked issue whose pushed fields differ from the snapshot, for fields whose
//     direction is not jira-to-board                             -> ONE coalesced `fields` entry
// The very first run only records a baseline, so enabling sync never floods Jira with
// the project's history; an issue seen for the first time is baselined the same way.

import { customPrefixesFromSetting, stripAttachmentFooter } from "./jira-context.mjs";
import { hasAttributionMarker } from "./comment-marker.mjs";
import { labelsFromBoardTags, mapBoardTypeToJira } from "./field-map.mjs";
import { LEGACY_DIRECTIONS, pushesField } from "./sync-direction.mjs";
import { boardLinksOf, parseLinkKey } from "./link-sync.mjs";

// Custom-field-map prefixes (#1701) are board-only tags like sprint:/version:; read from the plugin's own setting env
// so every caller (push, pull re-baselining) filters the same labels.
const configuredPrefixes = () => customPrefixesFromSetting(process.env.SYNC_CONFIG_CUSTOMFIELDMAP);

const norm = (v) => String(v ?? "").replace(/\r\n/g, "\n").trim();

/** The board fields push can write to Jira, in comparable form (the snapshot's `fields`). */
export function pushFieldsOf(issue, { extraPrefixes = configuredPrefixes() } = {}) {
  return {
    title: norm(issue.title),
    description: norm(stripAttachmentFooter(issue.description)),
    priority: norm(issue.priority),
    type: norm(issue.issueType ?? issue.type),
    labels: labelsFromBoardTags(issue.tags, { extraPrefixes }).sort(),
  };
}

const DELETED_TAG = "jira:deleted"; // = sync-engine's DELETED_TAG (not imported: avoids a cycle)

function isTaggedDeleted(issue) {
  return (issue.tags ?? []).some((t) => (typeof t === "string" ? t : t?.name) === DELETED_TAG);
}

export function statusNameOf(issue, statusNameById) {
  return (
    (issue.statusId && statusNameById.get(issue.statusId)) ||
    (typeof issue.status === "string" ? issue.status : issue.status?.name) ||
    null
  );
}

/** A board comment worth sending to Jira: human/agent note, not an echo of Jira content. */
export function isOutboundComment(comment) {
  if (!comment?.body) return false;
  if (comment.payload?.origin === "jira" || comment.origin === "jira") return false;
  if (hasAttributionMarker(comment.body)) return false;
  if (comment.kind && comment.kind !== "note") return false;
  return !["system", "preflight"].includes(comment.author);
}

/**
 * @param {{
 *   issues: Array<object>, statusNameById: Map<string,string>,
 *   commentsByIssueId: Record<string, Array<object>>,
 *   snapshot: {issues: Record<string,{status:string|null,createRequested?:boolean}>, commentsSeen: string[]}|null,
 *   outboxEntries?: Array<object>, pendingWritebackIds?: Set<string>, createEnabled?: boolean,
 *   directions?: ReturnType<typeof import("./sync-direction.mjs").resolveSyncDirections>,
 * }} input
 * @returns `supersedeKeys`: Jira keys whose already-queued `fields` entry this run replaces.
 */
export function planOutbox({
  issues,
  statusNameById,
  commentsByIssueId,
  snapshot,
  outboxEntries = [],
  pendingWritebackIds = new Set(),
  createEnabled = false,
  directions = LEGACY_DIRECTIONS,
  dependencies = [],
  extraPrefixes = configuredPrefixes(),
}) {
  const baseline = snapshot == null;
  const prevIssues = snapshot?.issues ?? {};
  const seen = new Set(snapshot?.commentsSeen ?? []);
  const entries = [];
  const supersedeKeys = [];
  const next = { issues: {}, commentsSeen: [] };
  const queued = (pred) => outboxEntries.some(pred) || entries.some(pred);

  for (const issue of issues) {
    const status = statusNameOf(issue, statusNameById);
    const prev = prevIssues[issue.id];
    const fields = pushFieldsOf(issue, { extraPrefixes });
    next.issues[issue.id] = { status, fields, ...(prev?.createRequested ? { createRequested: true } : {}) };

    if (issue.externalKey) {
      // Never queue outbound entries for an issue whose Jira twin is gone (#1629).
      if (isTaggedDeleted(issue)) continue;
      if (directions.pushStatus && !baseline && prev && prev.status !== status && status) {
        const same = (e) => e.kind === "transition" && e.key === issue.externalKey && e.targetStatus === status;
        if (!queued(same)) {
          entries.push({ kind: "transition", key: issue.externalKey, targetStatus: status, boardIssueId: issue.id });
        }
      }
      if (!baseline && prev?.fields) {
        const changed = Object.keys(fields).filter(
          (f) => pushesField(directions, f) && JSON.stringify(fields[f]) !== JSON.stringify(prev.fields[f]),
        );
        if (changed.length > 0) {
          // Coalesce per issue: the entry carries the LATEST values of every changed field and
          // replaces a still-queued one, so n edits before a push make one Jira write.
          const queuedFields = outboxEntries.find((e) => e.kind === "fields" && e.key === issue.externalKey)?.fields ?? {};
          entries.push({
            kind: "fields",
            key: issue.externalKey,
            boardIssueId: issue.id,
            fields: { ...queuedFields, ...Object.fromEntries(changed.map((f) => [f, fields[f]])) },
          });
          supersedeKeys.push(issue.externalKey);
        }
      }
      for (const c of commentsByIssueId[issue.id] ?? []) {
        next.commentsSeen.push(c.id);
        if (!directions.pushComments || seen.has(c.id) || baseline || !prev || !isOutboundComment(c)) continue;
        const same = (e) => e.kind === "comment" && e.comment?.boardCommentId === c.id;
        if (!queued(same)) {
          entries.push({ kind: "comment", key: issue.externalKey, comment: { body: c.body, boardCommentId: c.id } });
        }
      }
    } else if (createEnabled && !baseline && !prev && !pendingWritebackIds.has(issue.id)) {
      const same = (e) => e.kind === "create" && e.boardIssueId === issue.id;
      if (!queued(same)) {
        entries.push({
          kind: "create",
          boardIssueId: issue.id,
          fields: {
            summary: issue.title,
            description: stripAttachmentFooter(issue.description) ?? undefined,
            labels: labelsFromBoardTags(issue.tags, { extraPrefixes }),
            ...(mapBoardTypeToJira(issue.issueType) ? { issuetype: { name: mapBoardTypeToJira(issue.issueType) } } : {}),
          },
        });
        next.issues[issue.id].createRequested = true;
      }
    }
  }
  // Dependencies between two tracked issues -> Jira links (#1700). Always recorded in the snapshot (so a
  // later switch of direction does not flood Jira); only queued when the direction pushes links.
  const keyById = new Map(issues.filter((i) => i.externalKey && !isTaggedDeleted(i)).map((i) => [i.id, i.externalKey]));
  const boardLinks = boardLinksOf(dependencies, keyById);
  const linkKeys = [...new Set(boardLinks.map((l) => l.key))].sort();
  next.links = linkKeys;
  if (pushesField(directions, "links") && !baseline && snapshot?.links) {
    const before = new Set(snapshot.links);
    const now = new Set(linkKeys);
    const push = (action, key) => {
      const { kind, from, to } = parseLinkKey(key);
      const same = (e) => e.kind === "link" && e.action === action && e.linkKey === key;
      if (!queued(same)) entries.push({ kind: "link", action, linkKey: key, linkType: kind, from, to });
    };
    for (const k of linkKeys) if (!before.has(k)) push("add", k);
    for (const k of before) if (!now.has(k)) push("remove", k);
  }
  return { entries, nextSnapshot: next, supersedeKeys };
}
