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
  return `${prefix}/${num}${slug}`;
}
