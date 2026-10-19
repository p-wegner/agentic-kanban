// The declared Jira -> board field map (#1078): summary -> title, description ->
// description, status category -> board status, priority -> priority, labels -> tags,
// assignee -> tag. Pure (no fetch, no fs) so it is trivially unit-testable and so a
// later push half (#1079) can import just this, not the rest of the pull machinery.

import { adfToMarkdown } from "./adf.mjs";

/** The Jira fields a pull needs to fetch to populate every mapped board field. */
export const FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "assignee",
  "updated",
  "issuetype",
  "parent",
  "comment",
];

// Mirrors packages/shared/src/lib/issue-priority.ts's canonical vocabulary
// (critical/high/medium/low). Duplicated rather than imported: this plugin is a
// standalone zero-dependency Node script — not a pnpm workspace package — and stays
// that way so it runs offline with no install step (see the plugin's own README).
const BOARD_PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const JIRA_PRIORITY_TO_BOARD = {
  highest: "critical",
  urgent: "critical",
  high: "high",
  medium: "medium",
  normal: "medium",
  low: "low",
  lowest: "low",
};

/** Folds a Jira priority name into the board's canonical vocabulary. Unknown/absent -> "medium". */
export function mapJiraPriority(jiraPriorityName) {
  if (!jiraPriorityName) return "medium";
  const key = String(jiraPriorityName).trim().toLowerCase();
  if (BOARD_PRIORITIES.has(key)) return key;
  return JIRA_PRIORITY_TO_BOARD[key] ?? "medium";
}

// Jira's statusCategory.key is a fixed three-value enum ("new" | "indeterminate" |
// "done") shared by every workflow. Board statuses are per-project free-text columns
// (project_statuses), so there is no ID to map onto directly — resolveBoardStatusId
// below picks the first of these candidate NAMES that exists on the target project,
// falling back to the project's default status.
const STATUS_CATEGORY_CANDIDATES = {
  new: ["Todo", "To Do", "Backlog"],
  indeterminate: ["In Progress", "Doing", "In Review"],
  done: ["Done", "Closed"],
};

/**
 * @param {string|null} statusCategoryKey
 * @param {Array<{id:string,name:string,isDefault?:boolean}>} boardStatuses
 * @returns {string|null} a status id, or null when the project has no statuses at all
 */
export function resolveBoardStatusId(statusCategoryKey, boardStatuses) {
  const candidates = STATUS_CATEGORY_CANDIDATES[statusCategoryKey] ?? [];
  for (const name of candidates) {
    const match = boardStatuses.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
  }
  const fallback = boardStatuses.find((s) => s.isDefault) ?? boardStatuses[0];
  return fallback ? fallback.id : null;
}

/** Description as Markdown (#1624): plain strings pass through, ADF is converted. */
function markdownFromDescription(description) {
  return adfToMarkdown(description ?? null);
}

// Board issue types are task|bug|feature|chore; `epic` is a TAG there, not a type.
const JIRA_TYPE_TO_BOARD = {
  bug: "bug",
  story: "feature",
  "new feature": "feature",
  improvement: "feature",
  epic: "feature",
  task: "task",
  "sub-task": "task",
  subtask: "task",
};

/** Maps a Jira issue type name to a board `{ type, tags }`; unknown names fall back to `task`. */
export function mapJiraIssueType(typeName) {
  const key = String(typeName ?? "").trim().toLowerCase();
  const type = JIRA_TYPE_TO_BOARD[key] ?? "task";
  return { type, tags: key === "epic" ? ["epic"] : [] };
}

/**
 * Maps one Jira issue (a `searchAll`/`getIssue` result) to board issue fields per the
 * declared field map. `siteUrl` is optional and only used to build `externalUrl`.
 *
 * The board has no dedicated assignee column, so the assignee rides along as a
 * `assignee:<name>` tag, the same channel labels use — both are declared as "tags" in
 * the ticket's field map, and this is the one board concept that already generalizes
 * over free-text categorization.
 */
export function mapJiraIssueToBoardFields(jiraIssue, { siteUrl } = {}) {
  const fields = jiraIssue.fields ?? {};
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  const assigneeName = fields.assignee?.displayName ?? fields.assignee?.emailAddress ?? null;
  const tags = assigneeName ? [...labels, `assignee:${assigneeName}`] : [...labels];

  const { type, tags: typeTags } = mapJiraIssueType(fields.issuetype?.name);
  tags.push(...typeTags);

  // Parent/epic (#1624): an Epic parent becomes `epic:<KEY>`, any other parent
  // `parent:<KEY>`; the parent key is also written into the description.
  const parent = fields.parent ?? null;
  let parentLine = null;
  if (parent?.key) {
    const parentIsEpic = String(parent.fields?.issuetype?.name ?? "").toLowerCase() === "epic";
    tags.push(`${parentIsEpic ? "epic" : "parent"}:${parent.key}`);
    const parentSummary = parent.fields?.summary;
    parentLine = `**Parent:** ${parent.key}${parentSummary ? ` (${parentSummary})` : ""}`;
  }
  const body = markdownFromDescription(fields.description ?? null);
  const description = parentLine ? (body ? `${parentLine}

${body}` : parentLine) : body;

  const comments = (fields.comment?.comments ?? [])
    .map((c) => ({
      id: String(c.id),
      author: c.author?.displayName ?? c.author?.emailAddress ?? "unknown",
      created: c.created ?? null,
      body: adfToMarkdown(c.body ?? null) ?? "",
    }))
    .filter((c) => c.body !== "");

  return {
    externalKey: jiraIssue.key,
    externalUrl: siteUrl ? `${siteUrl.replace(/\/+$/, "")}/browse/${jiraIssue.key}` : null,
    title: fields.summary ?? jiraIssue.key,
    description,
    type,
    comments,
    priority: mapJiraPriority(fields.priority?.name ?? null),
    tags,
    statusCategoryKey: fields.status?.statusCategory?.key ?? null,
    jiraUpdated: fields.updated ?? null,
  };
}
