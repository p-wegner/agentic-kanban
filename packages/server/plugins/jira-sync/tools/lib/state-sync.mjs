// Keeps pull-state and push's board snapshot coherent with each other (#1629): a write
// by one half must never look like a foreign change to the other.

import { planOutbox, statusNameOf } from "./outbox-producer.mjs";
import { boardFieldsOf } from "./field-snapshot.mjs";

/** Issues, status names and (for tracked issues) comments: the inputs planOutbox diffs. */
export async function loadBoardState(boardClient, projectId) {
  const statuses = await boardClient.listStatuses(projectId);
  const issues = await boardClient.listIssues(projectId);
  const commentsByIssueId = {};
  for (const issue of issues) {
    if (issue.externalKey) commentsByIssueId[issue.id] = await boardClient.listComments(issue.id);
  }
  return { issues, statusNameById: new Map(statuses.map((s) => [s.id, s.name])), commentsByIssueId };
}

/**
 * After a successful push of a transition/create, the board issue's `updatedAt` moved (and
 * Jira's `updated` with it). Record both so the next pull does not call our own push a
 * local edit. Returns a new pull-state; per-key lookup failures leave that key untouched.
 */
export async function refreshPullStateAfterPush({ client, boardClient, projectId, pullState, applied }) {
  const keys = [
    ...new Set(
      applied
        .filter((a) => (a.kind === "transition" || a.kind === "create") && a.key && !a.wouldApply)
        .map((a) => a.key),
    ),
  ];
  const next = { ...pullState, issues: { ...pullState.issues } };
  if (keys.length === 0) return next;
  const byKey = await boardClient.listExternallyTrackedIssues(projectId);
  for (const key of keys) {
    const boardIssue = byKey.get(key);
    if (!boardIssue) continue;
    try {
      const jira = await client.getIssue(key, { fields: ["updated"] });
      next.issues[key] = {
        ...next.issues[key],
        updated: jira?.fields?.updated ?? next.issues[key]?.updated ?? null,
        boardIssueId: boardIssue.id,
        boardUpdatedAt: boardIssue.updatedAt,
        fields: boardFieldsOf(boardIssue),
      };
    } catch {
      // best effort: the pull falls back to reporting a conflict, as before
    }
  }
  return next;
}

/**
 * Pull-side snapshot upkeep. With no snapshot yet, the board is baselined NOW (first pull)
 * so edits made before the first push are still pushed; otherwise the issues pull wrote are
 * re-baselined so push never echoes them. Returns the snapshot to persist.
 */
export async function snapshotAfterPull({ boardClient, projectId, snapshot, touchedKeys }) {
  const state = await loadBoardState(boardClient, projectId);
  if (!snapshot) return planOutbox({ ...state, snapshot: null }).nextSnapshot;
  const next = { ...snapshot, issues: { ...snapshot.issues } };
  for (const issue of state.issues) {
    if (!touchedKeys.has(issue.externalKey)) continue;
    next.issues[issue.id] = { ...next.issues[issue.id], status: statusNameOf(issue, state.statusNameById) };
  }
  return next;
}
