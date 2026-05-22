import { workspaces, issues, projects, sessions, sessionMessages, diffComments, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

type Workspace = typeof workspaces.$inferSelect;

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
): Promise<Workspace | null> {
  const rows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
}

export async function updateWorkspaceStatus(
  workspaceId: string,
  status: string,
  extra: Partial<Omit<Workspace, "id" | "status">> = {},
  database: Database = db,
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .update(workspaces)
    .set({ status, updatedAt: now, ...extra } as Partial<Workspace>)
    .where(eq(workspaces.id, workspaceId));
}

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

/**
 * Move the issue associated with a workspace to "Done" (or "AI Reviewed" as fallback).
 * Logs a warning on failure but never throws.
 */
export async function moveIssueToDone(
  workspaceId: string,
  issueId: string,
  now: string,
  database: Database = db,
  fallbackToAiReviewed = false,
): Promise<void> {
  try {
    const projectId = await resolveProjectId(workspaceId, database);
    if (!projectId) return;
    const statuses = await database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
    const doneStatus = statuses.find(s => s.name === "Done")
      ?? (fallbackToAiReviewed ? statuses.find(s => s.name === "AI Reviewed") : undefined);
    if (doneStatus) {
      await database.update(issues).set({ statusId: doneStatus.id, updatedAt: now, statusChangedAt: now }).where(eq(issues.id, issueId));
    }
  } catch (err) {
    console.warn("[workspaces] Failed to move issue to Done:", err);
  }
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
