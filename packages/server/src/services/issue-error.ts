/**
 * Domain error for the issue service and its sub-services (dependency service,
 * etc.). Extracted into its own module so sibling sub-services can import the
 * runtime class without forming an import cycle with issue.service.ts (which
 * imports the sub-services back). Re-exported from issue.service.ts for
 * backward-compatible consumers.
 */
export class IssueError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}
