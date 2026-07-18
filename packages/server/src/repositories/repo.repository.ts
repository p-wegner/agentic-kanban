import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { repos, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

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

/**
 * The names of every repo a project touches: the leading repo (projects.repoName)
 * first, then the additional/sibling repos. A single-repo project returns a one-element
 * list — repo-aware authoring/decomposition (#94) keys off `length >= 2`. Names are
 * de-duped case-insensitively, preserving order and canonical spelling.
 */
export async function getProjectRepoNames(projectId: string, database: Database = db): Promise<string[]> {
  const project = await getProjectById(projectId, database);
  if (!project) return [];
  const siblings = await listProjectRepos(projectId, database);
  const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;
  const names = [project.repoName, ...siblings.map((r) => r.name ?? baseName(r.path))];
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function insertProjectRepo(
  input: { projectId: string; path: string; name?: string | null; defaultBranch?: string | null; setupScript?: string | null; composeFile?: string | null },
  database: RepoDb = db,
): Promise<RepoRow> {
  const row = {
    id: randomUUID(),
    projectId: input.projectId,
    workspaceId: null,
    path: input.path,
    name: input.name ?? null,
    defaultBranch: input.defaultBranch ?? null,
    setupScript: input.setupScript ?? null,
    composeFile: input.composeFile ?? null,
  };
  await database.insert(repos).values(row);
  const inserted = await database.select().from(repos).where(eq(repos.id, row.id)).limit(1);
  return inserted[0];
}

/** Update a project-scoped repo's per-repo setup/compose config (#71). */
export async function updateProjectRepo(
  repoId: string,
  patch: { name?: string; setupScript?: string | null; composeFile?: string | null },
  database: RepoDb = db,
): Promise<RepoRow | null> {
  const set: Partial<typeof repos.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.setupScript !== undefined) set.setupScript = patch.setupScript;
  if (patch.composeFile !== undefined) set.composeFile = patch.composeFile;
  if (Object.keys(set).length > 0) {
    await database.update(repos).set(set).where(eq(repos.id, repoId));
  }
  const rows = await database.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  return rows[0] ?? null;
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
    // Carried from the project-scoped repo row so provisioning (resolveExtraComposeFiles,
    // read at stack-up time from THIS workspace row) can join the sibling's own compose
    // into the workspace stack (#71). Without persisting it here the per-repo stack feature
    // is inert — the workspace row would always read composeFile=null.
    composeFile?: string | null;
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
    composeFile: input.composeFile ?? null,
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

/**
 * The ids of OTHER live (non-closed) workspaces whose repos rows reference the same
 * sibling worktree path or the same branch in the same repo. Closed workspaces don't
 * count: their rows persist only as the merge audit trail (and their leading
 * workingDir is nulled on close, so the leading guard skips them the same way) —
 * counting them would leak shared worktrees forever. Narrowed with a proper `where`
 * (workspace-scoped rows, excluding the caller's own workspace, joined against live
 * workspaces) instead of a where-less select + full-table JS filter.
 */
export async function findLiveSiblingSharers(
  repo: Pick<RepoRow, "path" | "worktreePath" | "branch">,
  excludeWorkspaceId: string,
  database: RepoDb = db,
): Promise<string[]> {
  const rows = await database
    .select({
      workspaceId: repos.workspaceId,
      path: repos.path,
      worktreePath: repos.worktreePath,
      branch: repos.branch,
    })
    .from(repos)
    .innerJoin(workspaces, eq(repos.workspaceId, workspaces.id))
    .where(
      and(
        isNotNull(repos.workspaceId),
        ne(repos.workspaceId, excludeWorkspaceId),
        ne(workspaces.status, "closed"),
      ),
    );

  const sharerIds = new Set<string>();
  for (const r of rows) {
    if (!samePath(r.path, repo.path)) continue;
    const sameWorktree = r.worktreePath !== null && repo.worktreePath !== null && samePath(r.worktreePath, repo.worktreePath);
    const sameBranch = r.branch !== null && r.branch === repo.branch;
    if (sameWorktree || sameBranch) sharerIds.add(r.workspaceId as string);
  }
  return [...sharerIds];
}

/**
 * Loose path equality (resolved + case-insensitive): worktree paths recorded by
 * different code paths (fresh join vs. git worktree-list reuse) can differ in
 * separators/case on Windows. A false positive only means cleanup is skipped —
 * the safe direction.
 */
function samePath(a: string, b: string): boolean {
  return pathResolve(a).toLowerCase() === pathResolve(b).toLowerCase();
}
