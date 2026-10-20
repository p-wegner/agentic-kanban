// `sync resolve` (#1643): settle ONE diverged issue on purpose, from a context that has no Jira
// credentials of its own (an agent working a "Resolve sync conflict" ticket). The board runs this
// with the credentials injected; the agent only names the key and the side to keep.
//
//   show        read-only: board now / last sync / Jira now, per mapped field
//   keep jira   force-pull that one issue: Jira overwrites the board issue
//   keep board  push the board's mapped fields to Jira once. Field edits are never pushed by the
//               regular push (it sends transitions, comments and creates), so this is the one
//               sanctioned field write, and only ever for the key it was asked about.
//
// Pure over injected clients and state, like the rest of lib/, so it is testable without a CLI.

import { FIELDS, mapJiraIssueToBoardFields, mapBoardTypeToJira, resolveBoardStatusId } from "./field-map.mjs";
import { markdownToAdf } from "./adf.mjs";
import { boardFieldsOf, fieldTable, incomingFieldsOf } from "./field-snapshot.mjs";
import { runInboundSync } from "./sync-engine.mjs";

const BOARD_PRIORITY_TO_JIRA = { critical: "Highest", high: "High", medium: "Medium", low: "Low" };

export const KEEP_SIDES = ["board", "jira"];

async function loadSides({ client, boardClient, projectId, siteUrl, key }) {
  const jiraIssue = await client.getIssue(key, { fields: FIELDS });
  const boardIssue = (await boardClient.listExternallyTrackedIssues(projectId)).get(key);
  if (!boardIssue) return { error: `no board issue is linked to ${key}` };
  const boardStatuses = await boardClient.listStatuses(projectId);
  return { jiraIssue, boardIssue, boardStatuses, mapped: mapJiraIssueToBoardFields(jiraIssue, { siteUrl }) };
}

/**
 * @returns {Promise<{ ok: boolean, mode: "show"|"keep", key: string, keep?: string, fields?: object[], nextState?: object, reason?: string }>}
 */
export async function resolveIssue({ client, boardClient, projectId, siteUrl, key, keep, knownState, now = new Date().toISOString() }) {
  if (!key) return { ok: false, mode: keep ? "keep" : "show", key, reason: "an issue key is required" };
  if (keep != null && !KEEP_SIDES.includes(keep)) {
    return { ok: false, mode: "keep", key, reason: `"keep" must be "board" or "jira" (got "${keep}")` };
  }
  const sides = await loadSides({ client, boardClient, projectId, siteUrl, key });
  if (sides.error) return { ok: false, mode: keep ? "keep" : "show", key, reason: sides.error };
  const { jiraIssue, boardIssue, boardStatuses, mapped } = sides;
  const known = knownState.issues[key];
  const statusName = (id) => boardStatuses.find((st) => st.id === id)?.name ?? id;
  const table = () =>
    fieldTable(
      boardFieldsOf(boardIssue),
      known?.fields ?? null,
      incomingFieldsOf(mapped, resolveBoardStatusId(mapped.statusCategoryKey, boardStatuses)),
      { statusName },
    );

  if (keep == null) return { ok: true, mode: "show", key, fields: table() };

  if (keep === "jira") {
    // A one-issue pull. The engine classifies every KNOWN key missing from the search as deleted
    // or out of scope, so it is handed only this key's state, and the result merged back.
    const result = await runInboundSync(client, boardClient, {
      jql: `key = "${key}"`,
      siteUrl,
      projectId,
      knownState: { issues: known ? { [key]: known } : {} },
      forceKeys: new Set([key]),
      now,
    });
    const nextState = { issues: { ...knownState.issues, ...(result.nextState.issues[key] ? { [key]: result.nextState.issues[key] } : {}) } };
    return { ok: true, mode: "keep", key, keep, fields: table(), nextState, applied: "board overwritten from Jira" };
  }

  // keep board
  const fields = { summary: boardIssue.title };
  if (boardIssue.description != null) fields.description = markdownToAdf(boardIssue.description);
  const priority = BOARD_PRIORITY_TO_JIRA[String(boardIssue.priority ?? "").toLowerCase()];
  if (priority) fields.priority = { name: priority };
  const issueType = mapBoardTypeToJira(boardIssue.issueType);
  if (issueType) fields.issuetype = { name: issueType };
  await client.updateIssueFields(key, fields);

  // Re-baseline against what Jira holds NOW, so the next pull sees "unchanged", not a conflict.
  const after = await client.getIssue(key, { fields: FIELDS });
  const nextState = {
    issues: {
      ...knownState.issues,
      [key]: {
        ...known,
        updated: mapJiraIssueToBoardFields(after, { siteUrl }).jiraUpdated,
        boardIssueId: boardIssue.id,
        boardUpdatedAt: boardIssue.updatedAt,
        fields: boardFieldsOf(boardIssue),
      },
    },
  };
  return {
    ok: true,
    mode: "keep",
    key,
    keep,
    fields: table(),
    nextState,
    applied: `Jira updated from the board (${Object.keys(fields).join(", ")}); status is not written here, push handles transitions`,
  };
}
