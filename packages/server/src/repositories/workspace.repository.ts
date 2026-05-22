import { workspaces, issues, projects, sessions, sessionMessages, diffComments } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function resolveProjectRepo(
  workspaceId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string }> {
  const wsRows = await database
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) throw new Error("Workspace not found");

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) throw new Error("Issue not found");

  const projectRows = await database
    .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, issueRows[0].projectId))
    .limit(1);
  if (projectRows.length === 0) throw new Error("Project not found");

  return { repoPath: projectRows[0].repoPath, defaultBranch: projectRows[0].defaultBranch };
}

export async function resolveProjectId(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const wsRows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) return null;

  const issueRows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, wsRows[0].issueId))
    .limit(1);
  if (issueRows.length === 0) return null;

  return issueRows[0].projectId;
}

/** Cascade delete a workspace: diff comments → session messages → sessions → workspace record. */
export async function deleteWorkspaceCascade(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  const wsSessions = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));

  await database.delete(diffComments).where(eq(diffComments.workspaceId, workspaceId));
  if (wsSessions.length > 0) {
    await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, wsSessions.map(s => s.id)));
  }
  await database.delete(sessions).where(eq(sessions.workspaceId, workspaceId));
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
}
