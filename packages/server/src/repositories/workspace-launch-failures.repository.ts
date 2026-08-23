import { projectStatuses, issues, workspaces, sessions, workspaceSetupRun } from "@agentic-kanban/shared/schema";
import { eq, inArray, desc, and, ne, getTableColumns } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { projectStatusIdName } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";

export async function getProjectIdOrNull(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const project = await getProjectById(projectId, database);
  return project?.id ?? null;
}

export async function getProjectStatusRows(
  projectId: string,
  database: Database = db,
) {
  // Order-INDEPENDENT (#773): the caller reduces these to a Set of terminal status ids and
  // a Map<id, name>; neither reads a position.
  return listProjectStatusIdNames(projectId, database);
}

export async function getProjectIssueRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

export async function getNonClosedWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
) {
  return database
    // #815: the eight `latest_setup_*` columns moved to `workspace_setup_run`. The whole
    // workspace row is still spread here — only the setup fields come from the join, aliased
    // back to their old names, so the classifier downstream is untouched.
    .select({
      ...getTableColumns(workspaces),
      latestSetupCommand: workspaceSetupRun.command,
      latestSetupState: workspaceSetupRun.state,
      latestSetupStartedAt: workspaceSetupRun.startedAt,
      latestSetupEndedAt: workspaceSetupRun.endedAt,
      latestSetupExitCode: workspaceSetupRun.exitCode,
      latestSetupDurationMs: workspaceSetupRun.durationMs,
      latestSetupStdoutTail: workspaceSetupRun.stdoutTail,
      latestSetupStderrTail: workspaceSetupRun.stderrTail,
    })
    .from(workspaces)
    // LEFT, not inner — a workspace with no setup record must still be classifiable.
    .leftJoin(workspaceSetupRun, eq(workspaceSetupRun.workspaceId, workspaces.id))
    .where(and(
      inArray(workspaces.issueId, issueIds),
      ne(workspaces.status, "closed"),
    ));
}

export async function getSessionsForWorkspacesDesc(
  workspaceIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(desc(sessions.startedAt));
}
