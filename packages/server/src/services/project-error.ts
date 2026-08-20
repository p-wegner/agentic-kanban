/**
 * Domain error for project operations. Its `code` is mapped to an HTTP status
 * (400/404/409) by the routes' domain-error handler. Lives in its own module so
 * both `project.service.ts` and `project-repos.service.ts` can throw it without a
 * circular import (project.service re-exports it for existing importers).
 */
export class ProjectError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}
