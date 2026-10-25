// Keeps pull-state and push's board snapshot coherent with each other (#1629): a write
// by one half must never look like a foreign change to the other.

import { planOutbox, pushFieldsOf, statusNameOf } from "./outbox-producer.mjs";
import { boardFieldsOf } from "./field-snapshot.mjs";
import { uniqueByDepId } from "./link-sync.mjs";
import { LEGACY_DIRECTIONS, pushesField } from "./sync-direction.mjs";

function baselineAfterPush(boardFields, priorFields, directions, assigneeNotPushed = false) {
  if (!priorFields) return boardFields;
  const out = { ...boardFields };
  // A queued assignee change Jira has not taken yet (unmapped name, #1702) stays a divergence.
  if (assigneeNotPushed && "assignee" in priorFields) out.assignee = priorFields.assignee;
  for (const f of ["title", "description", "priority", "type", "assignee"]) if (!pushesField(directions, f) && f in priorFields) out[f] = priorFields[f];
  return out;
}

/** Issues, status names and (for tracked issues) comments: the inputs planOutbox diffs. */
export async function loadBoardState(boardClient, projectId) {
  const statuses = await boardClient.listStatuses(projectId);
  const issues = await boardClient.listIssues(projectId);
  const commentsByIssueId = {};
  for (const issue of issues) {
    if (issue.externalKey) commentsByIssueId[issue.id] = await boardClient.listComments(issue.id);
  }
  const edges = [];
  for (const issue of issues) {
    if (issue.externalKey) edges.push(...((await boardClient.getDependencies(issue.id)).dependencies ?? []));
  }
  return { issues, statusNameById: new Map(statuses.map((s) => [s.id, s.name])), commentsByIssueId, dependencies: uniqueByDepId(edges) };
}

/**
 * After a successful push of a transition/create, the board issue's `updatedAt` moved (and
 * Jira's `updated` with it). Re-baseline the board side so the next pull does not call our own
 * push a local edit; the Jira `updated` cursor of a tracked issue is deliberately kept (#1677). Returns a new pull-state; per-key lookup failures leave that key untouched.
 */
export async function refreshPullStateAfterPush({ client, boardClient, projectId, pullState, applied, failed = [], directions = LEGACY_DIRECTIONS }) {
  const assigneeFailed = new Set(failed.filter((f) => f.kind === "assignee").map((f) => f.key));
  const keys = [
    ...new Set(
      applied
        .filter((a) => (a.kind === "transition" || a.kind === "create" || a.kind === "fields" || a.kind === "assignee") && a.key && !a.wouldApply)
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
      // #1677: Jira's post-push `updated` also covers Jira-side edits/comments made since the last
      // pull, so an already-tracked issue keeps its previous cursor: the next pull sees the issue
      // as moved and imports them. Only the board side (fields, boardUpdatedAt) is re-baselined,
      // which is what stops the pull treating the push as a local edit (#1629). A freshly
      // created issue has no earlier cursor to protect.
      const prior = next.issues[key];
      const jira = prior?.updated != null ? null : await client.getIssue(key, { fields: ["updated"] });
      next.issues[key] = {
        ...prior,
        updated: prior?.updated != null ? prior.updated : (jira?.fields?.updated ?? null),
        boardIssueId: boardIssue.id,
        boardUpdatedAt: boardIssue.updatedAt,
        // A field push does not own (jira-to-board) keeps its last-agreed value: re-baselining it to the
        // board's would turn an unpushed board edit into silent drift or let the next pull overwrite it (#1696).
        fields: baselineAfterPush(boardFieldsOf(boardIssue), prior?.fields, directions, assigneeFailed.has(key)),
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
 *
 * `jiraValues` (#1696): `{ [jiraKey]: { field: valueJiraHolds } }` for board-owned fields Jira differs
 * on. Push's snapshot records Jira's value for them, so the next push sees the board value as a
 * change and puts it back into Jira instead of leaving the two sides apart for good.
 */
export async function snapshotAfterPull({ boardClient, projectId, snapshot, touchedKeys, jiraValues = {}, linkAdjust = null }) {
  const state = await loadBoardState(boardClient, projectId);
  if (!snapshot) return planOutbox({ ...state, snapshot: null }).nextSnapshot;
  const next = { ...snapshot, issues: { ...snapshot.issues } };
  if (linkAdjust && snapshot.links) {
    // Links pull wrote or removed must not echo as board changes; board-owned drift is put back as a change.
    const links = new Set(snapshot.links);
    for (const k of [...linkAdjust.add, ...linkAdjust.extra]) links.add(k);
    for (const k of [...linkAdjust.drop, ...linkAdjust.forget]) links.delete(k);
    next.links = [...links].sort();
  }
  for (const issue of state.issues) {
    const override = jiraValues[issue.externalKey];
    if (touchedKeys.has(issue.externalKey)) {
      next.issues[issue.id] = { ...next.issues[issue.id], status: statusNameOf(issue, state.statusNameById), fields: { ...pushFieldsOf(issue), ...override } };
    } else if (override && next.issues[issue.id]?.fields) {
      next.issues[issue.id] = { ...next.issues[issue.id], fields: { ...next.issues[issue.id].fields, ...override } };
    }
  }
  return next;
}
