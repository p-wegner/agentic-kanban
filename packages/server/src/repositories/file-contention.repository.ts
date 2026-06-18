import { workspaces, issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** A project's id + default branch, or undefined when the project doesn't exist. */
export async function getProjectDefaultBranch(
  projectId: string,
  database: Database = db,
): Promise<{ id: string; defaultBranch: string | null } | undefined> {
  const rows = await database
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0];
}

export interface ActiveContentionWorkspaceRow {
  workspaceId: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  workspaceStatus: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatus: string;
}

/** Active workspaces (in the given statuses) for a project, joined to issue + status info. */
export async function getActiveContentionWorkspaces(
  projectId: string,
  activeStatuses: string[],
  database: Database = db,
): Promise<ActiveContentionWorkspaceRow[]> {
  return database
    .select({
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      workspaceStatus: workspaces.status,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatus: projectStatuses.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(workspaces.status, activeStatuses),
      ),
    );
}
