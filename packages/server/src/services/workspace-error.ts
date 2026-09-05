/**
 * The workspace layer's domain error.
 *
 * Its own module so that `workspace-agent-selection.ts` can throw it without importing back
 * from the `workspace-internals` barrel that re-exports it — a runtime cycle that would
 * work only because the throw happens at call time, which is not a property worth relying on.
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
