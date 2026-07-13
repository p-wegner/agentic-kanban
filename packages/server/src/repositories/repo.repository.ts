import { randomUUID } from "node:crypto";
import { repos } from "@agentic-kanban/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

export type RepoDb = Database | TransactionClient;

/** A row of the `repos` table (see schema/repos.ts for the two row kinds). */
export type RepoRow = typeof repos.$inferSelect;

/**
 * Project-scoped rows (workspaceId NULL): the project's ADDITIONAL repos.
 * The leading repo lives on `projects.repoPath` and is never in this table —
 * an empty result means a plain single-repo project (the legacy fast path).
 */
export async function listProjectRepos(projectId: string, database: RepoDb = db): Promise<RepoRow[]> {
  return database
    .select()
    .from(repos)
    .where(and(eq(repos.projectId, projectId), isNull(repos.workspaceId)));
}

/** Workspace-scoped rows: the per-workspace worktree records for the additional repos. */
export async function listWorkspaceRepos(workspaceId: string, database: RepoDb = db): Promise<RepoRow[]> {
  return database.select().from(repos).where(eq(repos.workspaceId, workspaceId));
}

export async function insertProjectRepo(
  input: { projectId: string; path: string; name?: string | null; defaultBranch?: string | null },
  database: RepoDb = db,
): Promise<RepoRow> {
  const row = {
    id: randomUUID(),
    projectId: input.projectId,
    workspaceId: null,
    path: input.path,
    name: input.name ?? null,
    defaultBranch: input.defaultBranch ?? null,
  };
  await database.insert(repos).values(row);
  const inserted = await database.select().from(repos).where(eq(repos.id, row.id)).limit(1);
  return inserted[0];
}

export async function insertWorkspaceRepo(
  input: {
    workspaceId: string;
    projectId: string;
    path: string;
    name?: string | null;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    baseCommitSha?: string | null;
  },
  database: RepoDb = db,
): Promise<void> {
  await database.insert(repos).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    path: input.path,
    name: input.name ?? null,
    worktreePath: input.worktreePath,
    branch: input.branch,
    baseBranch: input.baseBranch,
    baseCommitSha: input.baseCommitSha ?? null,
  });
}

export async function setWorkspaceRepoMergedSha(
  repoId: string,
  mergedHeadSha: string,
  database: RepoDb = db,
): Promise<void> {
  await database.update(repos).set({ mergedHeadSha }).where(eq(repos.id, repoId));
}

export async function deleteProjectRepo(repoId: string, projectId: string, database: RepoDb = db): Promise<boolean> {
  // Select-before-delete: libsql reports rowsAffected/changes unreliably (see
  // issue-service.repository.ts), so existence is checked explicitly.
  const where = and(eq(repos.id, repoId), eq(repos.projectId, projectId), isNull(repos.workspaceId));
  const existing = await database.select({ id: repos.id }).from(repos).where(where).limit(1);
  if (existing.length === 0) return false;
  await database.delete(repos).where(where);
  return true;
}
