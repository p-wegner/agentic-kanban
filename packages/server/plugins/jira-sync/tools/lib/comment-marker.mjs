// Marks a comment pushed FROM the board so a future inbound sync (#1078) can
// recognize its own echo in Jira's activity feed and skip re-importing it —
// and so push itself never re-posts a comment that originated as an IMPORT
// from Jira in the first place (see push-plan.mjs's echo-suppression check,
// keyed on `entry.comment.origin === "jira"`, not on this marker).

const MARKER_PREFIX = "_Synced from agentic-kanban comment";

/** Appends the attribution marker to a comment body about to be posted to Jira. */
export function attributeComment(body, { boardCommentId }) {
  return `${body}\n\n${MARKER_PREFIX} ${boardCommentId}_`;
}

/** True when `text` already carries the attribution marker (in either direction). */
export function hasAttributionMarker(text) {
  return typeof text === "string" && text.includes(MARKER_PREFIX);
}
