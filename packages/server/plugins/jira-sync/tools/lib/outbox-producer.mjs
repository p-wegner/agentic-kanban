// Fills the outbox from board state (#1623). The plugin contract has no board-event
// hook, so push diffs the board against a snapshot of what it saw last time:
//   - a tracked issue (has `externalKey`) whose status changed  -> one transition entry
//   - a new board comment that did not originate in Jira        -> one comment entry
//   - (opt-in) a new issue with no `externalKey`                -> one create entry
// The very first run only records a baseline, so enabling sync never floods Jira with
// the project's history; an issue seen for the first time is baselined the same way.

import { hasAttributionMarker } from "./comment-marker.mjs";

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
 * }} input
 */
export function planOutbox({
  issues,
  statusNameById,
  commentsByIssueId,
  snapshot,
  outboxEntries = [],
  pendingWritebackIds = new Set(),
  createEnabled = false,
}) {
  const baseline = snapshot == null;
  const prevIssues = snapshot?.issues ?? {};
  const seen = new Set(snapshot?.commentsSeen ?? []);
  const entries = [];
  const next = { issues: {}, commentsSeen: [] };
  const queued = (pred) => outboxEntries.some(pred) || entries.some(pred);

  for (const issue of issues) {
    const status = statusNameOf(issue, statusNameById);
    const prev = prevIssues[issue.id];
    next.issues[issue.id] = { status, ...(prev?.createRequested ? { createRequested: true } : {}) };

    if (issue.externalKey) {
      if (!baseline && prev && prev.status !== status && status) {
        const same = (e) => e.kind === "transition" && e.key === issue.externalKey && e.targetStatus === status;
        if (!queued(same)) {
          entries.push({ kind: "transition", key: issue.externalKey, targetStatus: status, boardIssueId: issue.id });
        }
      }
      for (const c of commentsByIssueId[issue.id] ?? []) {
        next.commentsSeen.push(c.id);
        if (seen.has(c.id) || baseline || !prev || !isOutboundComment(c)) continue;
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
          fields: { summary: issue.title, description: issue.description ?? undefined },
        });
        next.issues[issue.id].createRequested = true;
      }
    }
  }
  return { entries, nextSnapshot: next };
}
