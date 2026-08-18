/**
 * Reserved `:repoName` path segment for the LEADING repo in the per-repo rebase route
 * (POST /api/workspaces/:id/repos/:repoName/rebase, #93). The leading repo has a null
 * `name` so it can't be addressed by name; this sentinel stands in for it. Shared so the
 * client and server agree on the wire value (a plain string — client-bundle safe).
 */
export const LEADING_REPO_KEY = "__leading__";

export function sanitizeBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80);
}

export function suggestBranchName(issue: { issueNumber?: number | null; title: string }): string {
  const prefix = "feature";
  const num = issue.issueNumber ? `${issue.issueNumber}-` : "";
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${prefix}/ak-${num}${slug}`;
}

/**
 * The inverse of {@link suggestBranchName}: the issue number encoded in a branch name, or
 * null when it encodes none.
 *
 * #548: five call sites re-derived this with five different acceptance rules, and the loose
 * ones are a work-losing bug class rather than a tidiness problem — a reconciler that
 * matches the wrong number force-Dones the wrong issue (see the recycled-number incident
 * behind #146). So the rule here is deliberately strict on all three sides:
 *
 *  - **`ak-` is required.** A bare leading number is NOT an issue number. `workspace-teardown`
 *    accepted `(?:ak-)?(\d+)-`, so `feature/2026-refresh` exported `KANBAN_ISSUE_NUMBER=2026`
 *    to every teardown script. A branch that merely starts with a year is not issue 2026.
 *  - **A non-alphanumeric boundary before `ak`,** not `\b`. Sanitised names replace `/` with
 *    `_`, which is itself a `\w` character, so `\b` never matches in `feature_ak-1-…`; and a
 *    plain unanchored `ak-` would match inside `weak-105`.
 *  - **A non-alphanumeric boundary (or end) after the digits,** so `ak-105abc` is not 105.
 *
 * The FIRST match wins, which is what anchors the answer to the branch-name position:
 * `feature/ak-105-fix-ak-104-regression` is issue 105, not 104 (#146).
 */
export function parseIssueNumberFromBranch(name: string | null | undefined): number | null {
  if (!name) return null;
  const match = name.match(/(?:^|[^a-z0-9])ak-(\d+)(?:[^a-z0-9]|$)/i);
  return match ? Number(match[1]) : null;
}
