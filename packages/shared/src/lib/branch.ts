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
