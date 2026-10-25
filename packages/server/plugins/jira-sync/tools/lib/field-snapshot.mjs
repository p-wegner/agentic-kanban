// Field-level conflict detection (#1635). A board issue's `updatedAt` also moves for edits the
// sync does not map (tags, comments, a push transition), so it only says "something changed".
// What decides a conflict is whether the MAPPED fields (title, description, priority, type,
// status) differ from the last-synced snapshot and from what Jira now says.
//
// Board field edits are NOT pushed to Jira (push sends transitions, comments and creates only),
// so a snapshot is the only record that a board-side edit has been seen and agreed on.

import { stripAttachmentFooter } from "./jira-context.mjs";
import { assigneeFromTags } from "./field-map.mjs";

// The attachment footer (#1701) is plugin-owned and not a snapshot field: stripped before comparing.
const norm = (v) => String(v ?? "").replace(/\r\n/g, "\n").trim();

/** The mapped fields of a board issue, in comparable form. */
export function boardFieldsOf(boardIssue) {
  return {
    title: norm(boardIssue.title),
    description: norm(stripAttachmentFooter(boardIssue.description)),
    priority: norm(boardIssue.priority),
    type: norm(boardIssue.issueType ?? boardIssue.type),
    statusId: norm(boardIssue.statusId),
    assignee: norm(assigneeFromTags(boardIssue.tags)),
  };
}

/** The fields a pull would write from `mapped` (status already resolved to a board status id). */
export function incomingFieldsOf(mapped, statusId) {
  return {
    title: norm(mapped.title),
    description: norm(mapped.description),
    priority: norm(mapped.priority),
    type: norm(mapped.type),
    statusId: norm(statusId),
    assignee: norm(mapped.assignee),
  };
}

/** Field-by-field equality; `statusId` is skipped when `b` has none (project without statuses). */
export function fieldsEqual(a, b) {
  // A baseline recorded before `assignee` was a snapshot field (#1702) has no value: not a difference.
  return ["title", "description", "priority", "type", "statusId", "assignee"].every((k) =>
    (k === "statusId" && !b[k]) || (k === "assignee" && b[k] === undefined) ? true : a[k] === b[k],
  );
}

const TABLE_FIELDS = ["title", "description", "priority", "type", "statusId", "assignee"];

/**
 * The three-way view of a diverged issue, one row per mapped field: what the board holds now, what the
 * last sync agreed on, and what Jira says now. `lastSync` is null when no baseline was ever recorded.
 * `statusName` turns a board status id into something a reader (or an agent) can compare.
 */
export function fieldTable(board, lastSync, jira, { statusName = (id) => id } = {}) {
  const show = (field, value) => (field === "statusId" && value ? statusName(value) : value ?? null);
  return TABLE_FIELDS.map((field) => ({
    field: field === "statusId" ? "status" : field,
    board: show(field, board?.[field]),
    lastSync: lastSync ? show(field, lastSync[field]) : null,
    jira: show(field, jira?.[field]),
    differs: (board?.[field] ?? "") !== (jira?.[field] ?? ""),
  }));
}
