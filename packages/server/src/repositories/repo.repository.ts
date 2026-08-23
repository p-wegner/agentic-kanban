import { randomUUID } from "node:crypto";
import { samePath as sharedSamePath } from "@agentic-kanban/shared/lib/path-key";
import { repos, workspaces, issues } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import type { RepoInstallState } from "@agentic-kanban/shared/lib/repo-install-state";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

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

/**
 * Workspace-scoped SIBLING rows: the per-workspace worktree records for the additional repos.
 * Excludes the leading-repo row (#222 stage 1, `is_leading=1`) — every consumer of this
 * function means "the siblings", and before the filter the backfilled leading row would have
 * been double-counted as a sibling (breaking single-repo fast paths and sibling merges).
 */
export async function listWorkspaceRepos(workspaceId: string, database: RepoDb = db): Promise<RepoRow[]> {
  return database.select().from(repos).where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, false)));
}

/** The workspace's physical leading-repo row (#222 stage 1), or null when not yet backfilled. */
export async function getLeadingRepoRow(workspaceId: string, database: RepoDb = db): Promise<RepoRow | null> {
  return firstRow(
    database
      .select()
      .from(repos)
      .where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, true)))
      .limit(1)
  );
}

/**
 * Insert the physical leading-repo row for a new workspace (#222 stage 1). Mirrors what
 * migration 0110 backfills for pre-existing workspaces: one `is_leading=1` row carrying the
 * same git state the `workspaces` columns hold (which remain the read model until stage 2).
 * The deterministic id makes a re-run (or a create retried after a crash) idempotent.
 */
export async function insertLeadingWorkspaceRepo(
  input: {
    workspaceId: string;
    path: string;
    defaultBranch?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    baseCommitSha?: string | null;
  },
  database: RepoDb = db,
): Promise<void> {
  await database
    .insert(repos)
    .values({
      id: `leading-${input.workspaceId}`,
      workspaceId: input.workspaceId,
      projectId: null,
      path: input.path,
      name: null,
      defaultBranch: input.defaultBranch ?? null,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      baseBranch: input.baseBranch ?? null,
      baseCommitSha: input.baseCommitSha ?? null,
      isLeading: true,
    })
    .onConflictDoNothing();
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
  return firstRow(database.select().from(repos).where(eq(repos.id, repoId)).limit(1));
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
    /**
     * #628 — only the `background` install mode sets this (to `pending`). Left NULL by the
     * inline modes, where the install has already run before this row exists.
     */
    installState?: RepoInstallState | null;
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
    installState: input.installState ?? null,
    installUpdatedAt: input.installState ? new Date().toISOString() : null,
  });
}

/**
 * Dual-write (#222 stage 2): mirror a change to the workspace's git-state columns onto its
 * physical leading-repo row. The `workspaces` columns remain the read model until stage 4;
 * this keeps the leading row convergent so the eventual source-of-truth flip is a no-op.
 * A workspace without a leading row (created in the stage-1→2 window) is a silent no-op —
 * `leadingRef`'s read-repair backfills it on the next read.
 */
export async function mirrorWorkspaceColumnsToLeadingRepo(
  workspaceId: string,
  patch: {
    branch?: string | null;
    workingDir?: string | null;
    baseBranch?: string | null;
    baseCommitSha?: string | null;
    mergedHeadSha?: string | null;
  },
  database: RepoDb = db,
): Promise<void> {
  const set: Partial<typeof repos.$inferInsert> = {};
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.workingDir !== undefined) set.worktreePath = patch.workingDir;
  if (patch.baseBranch !== undefined) set.baseBranch = patch.baseBranch;
  if (patch.baseCommitSha !== undefined) set.baseCommitSha = patch.baseCommitSha;
  if (patch.mergedHeadSha !== undefined) set.mergedHeadSha = patch.mergedHeadSha;
  if (Object.keys(set).length === 0) return;
  // #415 — any mirrored git-state change can move the row's projected merge-status
  // facts (ahead/historic), so the projection is dirtied atomically with the mirror.
  set.summaryDirty = true;
  await database
    .update(repos)
    .set(set)
    .where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, true)));
}

export async function setWorkspaceRepoMergedSha(
  repoId: string,
  mergedHeadSha: string,
  database: RepoDb = db,
): Promise<void> {
  // #415 — the merge stamp changes the row's merge-status verdict; dirty the projection
  // atomically (the stamped sha itself short-circuits reads, but ahead/historic move too).
  await database.update(repos).set({ mergedHeadSha, summaryDirty: true }).where(eq(repos.id, repoId));
}

/**
 * #628 — advance one workspace repo's dependency-install state. Keyed by (workspaceId, path)
 * rather than by row id because the background runner is handed the SIBLING descriptors that
 * `provisionSiblingWorktrees` returned, which predate the rows: the rows are inserted in the
 * create transaction, after provisioning has already handed back its result.
 */
export async function setWorkspaceRepoInstallState(
  params: { workspaceId: string; path: string; state: RepoInstallState; detail?: string | null },
  database: RepoDb = db,
): Promise<void> {
  await database
    .update(repos)
    .set({
      installState: params.state,
      installDetail: params.detail ?? null,
      installUpdatedAt: new Date().toISOString(),
    })
    .where(and(eq(repos.workspaceId, params.workspaceId), eq(repos.path, params.path)));
}

/** The two states that mean "the deps for this repo are not on disk yet" (see `isRepoInstallOutstanding`). */
const OUTSTANDING_INSTALL_STATES: readonly RepoInstallState[] = ["pending", "running"];

/**
 * #714 — the CONDITIONAL counterpart of `setWorkspaceRepoInstallState`, for a writer that read
 * the row EARLIER and therefore cannot assume it still says what it said.
 *
 * The staleness reconciler is that writer: it `SELECT`s the outstanding rows, decides, and only
 * then writes. An unconditional `UPDATE … WHERE workspaceId AND path` clobbers a row that
 * reached `done` in between — the classic TOCTOU — and since the background runner writes the
 * row too, the state then oscillates. Putting the state it READ into the `WHERE` makes the write
 * itself the compare-and-swap.
 *
 * Returns whether the swap actually landed, so the caller reports what it DID rather than what
 * it intended. The verdict is read back rather than taken from `rowsAffected`, which libsql
 * reports unreliably (same reason `deleteProjectRepo` selects before deleting).
 */
export async function failRepoInstallIfStillIn(
  params: { workspaceId: string; path: string; fromStates: readonly RepoInstallState[]; detail: string; now?: string },
  database: RepoDb = db,
): Promise<boolean> {
  if (params.fromStates.length === 0) return false;
  const now = params.now ?? new Date().toISOString();
  const rowWhere = and(eq(repos.workspaceId, params.workspaceId), eq(repos.path, params.path));
  await database
    .update(repos)
    .set({ installState: "failed", installDetail: params.detail, installUpdatedAt: now })
    .where(and(rowWhere, inArray(repos.installState, [...params.fromStates])));
  const after = await database
    .select({ installState: repos.installState, installUpdatedAt: repos.installUpdatedAt })
    .from(repos)
    .where(rowWhere)
    .limit(1);
  const row = after[0];
  return Boolean(row && row.installState === "failed" && row.installUpdatedAt === now);
}

/**
 * #714 — the liveness signal the staleness sweep needs: re-stamp `installUpdatedAt` on the
 * still-outstanding rows of a run that IS progressing.
 *
 * Without it `installUpdatedAt` only ever moves on a state TRANSITION, so "stale" meant
 * "started a while ago" rather than "not progressing" — and the background runner installs at
 * concurrency 1. Two live runs were therefore reclaimed as abandoned: an install legitimately
 * longer than the staleness window (`sibling_install_timeout_ms_<projectId>` allows up to three
 * hours), and the TAIL of a multi-repo `pending` queue, which crosses the window while the
 * runner ahead of it is perfectly healthy. The heartbeat covers the whole outstanding queue for
 * that reason, not just the row currently running.
 *
 * Scoped to `pending`/`running` so it can never touch a row that has already settled — the same
 * predicate that makes the reclaim above a compare-and-swap.
 */
export async function touchOutstandingRepoInstalls(
  params: { workspaceId: string; paths: readonly string[]; now?: string },
  database: RepoDb = db,
): Promise<void> {
  if (params.paths.length === 0) return;
  await database
    .update(repos)
    .set({ installUpdatedAt: params.now ?? new Date().toISOString() })
    .where(
      and(
        eq(repos.workspaceId, params.workspaceId),
        inArray(repos.path, [...params.paths]),
        inArray(repos.installState, [...OUTSTANDING_INSTALL_STATES]),
      ),
    );
}

/**
 * #628 — the install states of every repo row of a workspace, LEADING INCLUDED. The merge
 * gate is the caller, and it means "did every dependency install for this workspace finish",
 * which is not a question about siblings specifically.
 */
export async function listWorkspaceRepoInstallStates(
  workspaceId: string,
  database: RepoDb = db,
): Promise<Array<{ name: string | null; path: string; installState: string | null; installDetail: string | null }>> {
  return database
    .select({
      name: repos.name,
      path: repos.path,
      installState: repos.installState,
      installDetail: repos.installDetail,
    })
    .from(repos)
    .where(eq(repos.workspaceId, workspaceId));
}

/**
 * #685 — every repo row across every LIVE (non-closed) workspace whose install is still
 * `pending`/`running`, with `installUpdatedAt` so a staleness sweep can tell "still working"
 * apart from "abandoned mid-install" (server crash, an early return before the runner started,
 * or a blocking leading-setup failure that skipped the deferred provisioning step entirely —
 * none of which ever advance this row again on their own). Closed workspaces are excluded:
 * their merge gate no longer matters, and reaping the row would just be noise.
 */
export async function listOutstandingRepoInstallRows(
  database: RepoDb = db,
): Promise<Array<{ workspaceId: string | null; path: string; name: string | null; installState: string | null; installUpdatedAt: string | null }>> {
  return database
    .select({
      workspaceId: repos.workspaceId,
      path: repos.path,
      name: repos.name,
      installState: repos.installState,
      installUpdatedAt: repos.installUpdatedAt,
    })
    .from(repos)
    .innerJoin(workspaces, eq(repos.workspaceId, workspaces.id))
    .where(
      and(
        isNotNull(repos.workspaceId),
        or(eq(repos.installState, "pending"), eq(repos.installState, "running")),
        ne(workspaces.status, "closed"),
      ),
    );
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
/**
 * Cross-project shared-sibling guard (#110): the SAME git repo can be registered as
 * a sibling under two different projects. Git allows only ONE worktree per branch, so
 * if both projects drive a workspace whose branch name collides in that shared repo,
 * `createWorktree`'s reuse-by-branch path would SILENTLY hand the second project the
 * first's worktree + branch — conflating two unrelated projects' work onto one branch.
 *
 * This finds any LIVE (non-closed) workspace in a DIFFERENT project that already holds
 * `branch` in the repo at `repoPath`. A non-empty result means provisioning would be
 * a cross-project collision and the caller should refuse with a clear error rather than
 * adopt. SAME-project reuse (fix-and-merge reconcilers, relaunch) is intentional and is
 * excluded here by the `projectId` filter, so this never fires for single-project flows.
 */
export async function findCrossProjectBranchHolders(
  params: { repoPath: string; branch: string; projectId: string },
  database: RepoDb = db,
): Promise<{ workspaceId: string; projectId: string }[]> {
  const rows = await database
    .select({
      workspaceId: repos.workspaceId,
      path: repos.path,
      branch: repos.branch,
      repoProjectId: repos.projectId,
    })
    .from(repos)
    .innerJoin(workspaces, eq(repos.workspaceId, workspaces.id))
    .where(
      and(
        isNotNull(repos.workspaceId),
        eq(repos.isLeading, false),
        ne(workspaces.status, "closed"),
        ne(repos.projectId, params.projectId),
      ),
    );

  const holders: { workspaceId: string; projectId: string }[] = [];
  for (const r of rows) {
    if (!samePath(r.path, params.repoPath)) continue;
    if (r.branch === null || r.branch !== params.branch) continue;
    holders.push({ workspaceId: r.workspaceId as string, projectId: (r.repoProjectId ?? "") as string });
  }
  return holders;
}

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
        eq(repos.isLeading, false),
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
 * Loose path equality: worktree paths recorded by different code paths (fresh join
 * vs. git worktree-list reuse) can differ in separators/case on Windows. Delegates
 * to the shared canonical key (#532) — this copy also stripped no trailing separator
 * and case-folded on POSIX, where case is significant.
 */
function samePath(a: string, b: string): boolean {
  return sharedSamePath(a, b);
}

/**
 * Every SIBLING worktree a project's live+closed workspaces claim, with the owning
 * workspace's issue (#631).
 *
 * The Worktrees panel could only ever answer "which workspace owns this?" for the LEADING
 * repo, because that link lives on `workspaces.working_dir`. A sibling's link lives here, on
 * the per-workspace `repos` row — so without this query every sibling worktree looked
 * unowned, and the panel had no way to distinguish a healthy multi-repo workspace from the
 * orphan debris it exists to surface.
 *
 * `isLeading` rows are excluded: they mirror the workspace's own columns and would duplicate
 * the leading entry the panel already renders.
 */
export async function getWorkspaceRepoClaims(
  projectId: string,
  database: Database = db,
): Promise<{
  repoPath: string;
  worktreePath: string | null;
  branch: string | null;
  workspaceId: string;
  status: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
}[]> {
  return database
    .select({
      repoPath: repos.path,
      worktreePath: repos.worktreePath,
      branch: repos.branch,
      workspaceId: workspaces.id,
      status: workspaces.status,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(repos)
    .innerJoin(workspaces, eq(repos.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(repos.projectId, projectId), or(isNull(repos.isLeading), eq(repos.isLeading, false))));
}
