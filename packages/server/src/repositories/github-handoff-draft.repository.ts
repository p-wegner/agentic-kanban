import { diffComments, issueArtifacts, issues, projects, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";

export async function getHandoffWorkspaceContext(
  workspaceId: string,
  database: Database,
) {
  const rows = await database
    .select({
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      repoPath: projects.repoPath,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0];
}

export async function getHandoffSessionRows(
  workspaceId: string,
  database: Database,
) {
  return database
    .select({ id: sessions.id, triggerType: sessions.triggerType, stats: sessions.stats })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt));
}

export async function getHandoffDiffComments(
  workspaceId: string,
  database: Database,
) {
  return database
    .select({ filePath: diffComments.filePath, lineNumNew: diffComments.lineNumNew, body: diffComments.body })
    .from(diffComments)
    .where(eq(diffComments.workspaceId, workspaceId))
    .orderBy(diffComments.createdAt);
}

export async function insertHandoffArtifact(
  artifact: {
    id: string;
    issueId: string;
    workspaceId: string;
    type: string;
    mimeType: string;
    content: string;
    caption: string;
  },
  database: Database,
): Promise<void> {
  await database.insert(issueArtifacts).values(artifact);
}

export async function getHandoffWorkspaceIssueId(
  workspaceId: string,
  database: Database,
): Promise<string | undefined> {
  const workspaceRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return workspaceRows[0]?.issueId;
}

export async function getLatestHandoffArtifact(
  workspaceId: string,
  caption: string,
  database: Database,
): Promise<{ id: string; content: string; createdAt: string } | undefined> {
  const rows = await database
    .select({ id: issueArtifacts.id, content: issueArtifacts.content, createdAt: issueArtifacts.createdAt })
    .from(issueArtifacts)
    .where(and(eq(issueArtifacts.workspaceId, workspaceId), eq(issueArtifacts.caption, caption)))
    .orderBy(desc(issueArtifacts.createdAt))
    .limit(1);
  return rows[0];
}
