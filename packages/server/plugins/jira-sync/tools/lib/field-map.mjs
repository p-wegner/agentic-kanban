// The declared Jira -> board field map (#1078): summary -> title, description ->
// description, status category -> board status, priority -> priority, labels -> tags,
// assignee -> tag. Pure (no fetch, no fs) so it is trivially unit-testable and so a
// later push half (#1079) can import just this, not the rest of the pull machinery.

/** The Jira fields a pull needs to fetch to populate every mapped board field. */
export const FIELDS = ["summary", "description", "status", "priority", "labels", "assignee", "updated"];

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

/** Best-effort plain text out of a Jira Cloud v3 description (plain string or ADF). */
function plainTextFromDescription(description) {
  if (description == null) return null;
  if (typeof description === "string") return description;
  if (typeof description === "object" && Array.isArray(description.content)) {
    return adfToPlainText(description).trim();
  }
  return null;
}

function adfToPlainText(node) {
  if (node.type === "text") return node.text ?? "";
  const children = Array.isArray(node.content) ? node.content.map(adfToPlainText).join("") : "";
  return node.type === "paragraph" ? `${children}\n\n` : children;
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

  return {
    externalKey: jiraIssue.key,
    externalUrl: siteUrl ? `${siteUrl.replace(/\/+$/, "")}/browse/${jiraIssue.key}` : null,
    title: fields.summary ?? jiraIssue.key,
    description: plainTextFromDescription(fields.description ?? null),
    priority: mapJiraPriority(fields.priority?.name ?? null),
    tags,
    statusCategoryKey: fields.status?.statusCategory?.key ?? null,
    jiraUpdated: fields.updated ?? null,
  };
}
