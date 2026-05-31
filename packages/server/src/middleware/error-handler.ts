import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError, AiOperationError } from "../errors/index.js";
import { WorkspaceError } from "../services/workspace.service.js";
import { IssueError } from "../services/issue.service.js";
import { ProjectError } from "../services/project.service.js";
import { ProjectScriptsError } from "../services/project-scripts.service.js";
import { SessionReadError } from "../services/session-read.service.js";
import { AgentSkillError } from "../services/agent-skill.service.js";
import { TagError } from "../services/tag.service.js";
import { ScheduledRunError } from "../services/scheduled-run.service.js";

type StatusCode = 400 | 403 | 404 | 409 | 500;

function codeToStatus(code: string): StatusCode {
  switch (code) {
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "FORBIDDEN": return 403;
    case "INTERNAL": return 500;
    default: return 400; // BAD_REQUEST, INVALID_DATA, etc.
  }
}

type DomainError =
  | WorkspaceError
  | IssueError
  | ProjectError
  | ProjectScriptsError
  | SessionReadError
  | AgentSkillError
  | TagError
  | ScheduledRunError;

function toDomainError(err: Error): DomainError | null {
  if (
    err instanceof WorkspaceError ||
    err instanceof IssueError ||
    err instanceof ProjectError ||
    err instanceof ProjectScriptsError ||
    err instanceof SessionReadError ||
    err instanceof AgentSkillError ||
    err instanceof TagError ||
    err instanceof ScheduledRunError
  ) {
    return err;
  }
  return null;
}

export function domainErrorHandler(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  if (err instanceof AiOperationError) {
    return c.json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) }, 500);
  }

  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.statusCode as StatusCode);
  }

  const domainErr = toDomainError(err);
  if (domainErr) {
    // Special case: WorkspaceError with conflict file data from merge
    if (domainErr instanceof WorkspaceError && domainErr.data?.conflictingFiles) {
      return c.json(
        { error: "Merge conflicts detected", conflictingFiles: domainErr.data.conflictingFiles },
        409,
      );
    }
    return c.json({ error: domainErr.message }, codeToStatus(domainErr.code));
  }

  console.error("[server] unhandled error:", err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
}
