/**
 * Project existence prelude (#510).
 *
 * Eleven route handlers opened with the same three lines:
 *
 *     const project = await getProjectById(id, database);
 *     if (!project) return c.json({ error: "Project not found" }, 404);
 *
 * ...except the message drifted between "Project not found" and "project not found"
 * depending on the file, so the same condition produced two different strings on the wire.
 * `domainErrorHandler` already maps a `NOT_FOUND` code to 404, so throwing is all a route
 * needs to do.
 *
 * The message is deliberately the existing capitalised spelling rather than something more
 * informative like `Project <id> not found`: unifying the casing is the fix this ticket
 * asked for, and changing the text as well would be a second, unrequested wire change.
 */
import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import { ProjectError } from "./project-error.js";

type ProjectRow = NonNullable<Awaited<ReturnType<typeof getProjectById>>>;

/** Load a project or throw `ProjectError(NOT_FOUND)`, which the central handler maps to 404. */
export async function requireProject(projectId: string, database: Database): Promise<ProjectRow> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
  return project;
}
