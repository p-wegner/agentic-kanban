import { workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** A project's id + default branch, or undefined when the project doesn't exist. */
// #502: one definition, in project.repository. This copy returned `| undefined` where
// the others returned `| null`; both are falsy, and the only caller tests truthiness.
export { getProjectDefaultBranch } from "./project.repository.js";

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
