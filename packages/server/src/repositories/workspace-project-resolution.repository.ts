import { workspaces, issues, projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { getProjectById } from "./project.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

type Project = typeof projects.$inferSelect;

export async function resolveProjectFull(
  workspaceId: string,
  database: Database = db,
): Promise<{ project: Project | null; repoPath: string; defaultBranch: string | null }> {
  const wsRows = await database
    .select({ issueId: workspaces.issueId })
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

  const project = await getProjectById(issueRows[0].projectId, database);
  if (!project) throw new Error("Project not found");

  return { project, repoPath: project.repoPath, defaultBranch: project.defaultBranch };
}

export async function resolveProjectRepo(
  workspaceId: string,
  database: Database = db,
): Promise<{ repoPath: string; defaultBranch: string | null }> {
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

  const project = await getProjectById(issueRows[0].projectId, database);
  if (!project) throw new Error("Project not found");

  return { repoPath: project.repoPath, defaultBranch: project.defaultBranch };
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
