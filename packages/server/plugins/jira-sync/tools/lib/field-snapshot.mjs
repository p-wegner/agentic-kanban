// Field-level conflict detection (#1635). A board issue's `updatedAt` also moves for edits the
// sync does not map (tags, comments, a push transition), so it only says "something changed".
// What decides a conflict is whether the MAPPED fields (title, description, priority, type,
// status) differ from the last-synced snapshot and from what Jira now says.
//
// Board field edits are NOT pushed to Jira (push sends transitions, comments and creates only),
// so a snapshot is the only record that a board-side edit has been seen and agreed on.

const norm = (v) => String(v ?? "").replace(/\r\n/g, "\n").trim();

/** The mapped fields of a board issue, in comparable form. */
export function boardFieldsOf(boardIssue) {
  return {
    title: norm(boardIssue.title),
    description: norm(boardIssue.description),
    priority: norm(boardIssue.priority),
    type: norm(boardIssue.issueType ?? boardIssue.type),
    statusId: norm(boardIssue.statusId),
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
  };
}

/** Field-by-field equality; `statusId` is skipped when `b` has none (project without statuses). */
export function fieldsEqual(a, b) {
  return ["title", "description", "priority", "type", "statusId"].every((k) => k === "statusId" && !b[k] ? true : a[k] === b[k]);
}
