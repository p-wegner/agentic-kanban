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
    /**
     * Index of the offending entry in a BATCH request (#510).
     *
     * This is the one thing the central `domainErrorHandler` could not emit, which is
     * why the batch routes kept hand-written try/catch blocks — and the reason it could
     * not was purely that the field lived nowhere: callers wrote
     * `new IssueError(msg, "BAD_REQUEST") as IssueError & { index?: number }`, a cast
     * repeated six times to bolt on a property the class did not declare. Declaring it
     * lets the handler spread it and the route catches go away.
     *
     * Undefined for non-batch errors; the handler omits the field entirely then, so the
     * single-item response shape is unchanged.
     */
    public readonly index?: number,
  ) {
    super(message);
  }
}
