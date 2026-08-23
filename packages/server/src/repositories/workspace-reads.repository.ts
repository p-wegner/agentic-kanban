import {
  workspaces,
  issues,
  sessions,
  agentSkills,
  repos,
} from "@agentic-kanban/shared/schema";
import { desc, eq, inArray, notInArray, and, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

/**
 * The workspace's LEADING repo row (#222 stage 1, migration 0110). Aliased because `repos`
 * also holds this workspace's SIBLING rows, and joining the table unaliased would multiply
 * the result by them — the mistake every "sibling repos" query has to guard against.
 */
const leadingRepo = alias(repos, "leading_repo");
import { findOpenUnmergedWorkspace as findOpenUnmergedWorkspaceShared } from "@agentic-kanban/shared/lib/issue-status-orchestration";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { TERMINAL_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-liveness";
import { mapWorkspaceDetailsRow } from "../lib/workspace-details-projection.js";
import type { WorkspaceDetails } from "../lib/workspace-details-projection.js";
import { firstRow } from "../lib/first-row.js";

type Workspace = typeof workspaces.$inferSelect;

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
): Promise<Workspace | null> {
  return firstRow(database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1));
}

/** All workspaces (full rows) for an issue (CLI `issue status` / `issue summary`). */
export async function getWorkspacesByIssueId(issueId: string, database: Database = db): Promise<Workspace[]> {
  return database.select().from(workspaces).where(eq(workspaces.issueId, issueId));
}

/**
 * Slim workspace list (id/status/readyForMerge/issueId/branch/provider/model/
 * mergedAt/isDirect/timestamps), scoped EITHER by issueId (no join) or by
 * projectId (join through issues). Optional status filter + limit/offset.
 * issueId takes precedence when both are passed (mirrors the route's branching).
 */
export async function listWorkspacesSlim(
  opts: { issueId?: string; projectId?: string; statusFilter?: string[] | null; limit?: number; offset?: number },
  database: Database = db,
) {
  const selectShape = {
    id: workspaces.id,
    issueId: workspaces.issueId,
    branch: workspaces.branch,
    status: workspaces.status,
    readyForMerge: workspaces.readyForMerge,
    provider: workspaces.provider,
    model: workspaces.model,
    mergedAt: workspaces.mergedAt,
    isDirect: workspaces.isDirect,
    // Included despite the slim contract: it is a plain column on `workspaces` (no join, no cost),
    // and its absence fails SILENTLY for anything driving workspaces over the API. A driver that
    // seeds files into a worktree reads `workingDir` off a list row, gets undefined, and skips the
    // seed instead of erroring — so the agent runs against a worktree missing its config and still
    // looks plausible. Session fields (`sessionStatus`, `lastSessionAt`) genuinely need the sessions
    // join and stay on the single-workspace GET only.
    workingDir: workspaces.workingDir,
    createdAt: workspaces.createdAt,
    updatedAt: workspaces.updatedAt,
  };
  const { issueId, projectId, statusFilter, limit, offset } = opts;

  if (issueId) {
    const conditions = [eq(workspaces.issueId, issueId)];
    if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
    let query = database.select(selectShape).from(workspaces).where(and(...conditions)).$dynamic();
    if (limit !== undefined) query = query.limit(limit);
    if (offset !== undefined) query = query.offset(offset);
    return query;
  }

  const conditions = [eq(issues.projectId, projectId!)];
  if (statusFilter) conditions.push(inArray(workspaces.status, statusFilter));
  let query = database
    .select(selectShape)
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(...conditions))
    .$dynamic();
  if (limit !== undefined) query = query.limit(limit);
  if (offset !== undefined) query = query.offset(offset);
  return query;
}

/**
 * Lightweight workspace rows for a set of issues — id/issueId/branch/status/closedAt.
 * Used by the standup digest to find merged (closed-in-window) workspaces and to
 * map workspace ids back to issues for the session rollup.
 */
export async function getWorkspacesForIssues(issueIds: string[], database: Database = db) {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      closedAt: workspaces.closedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

export async function getWorkspaceDetails(
  workspaceId: string,
  database: Database = db,
): Promise<WorkspaceDetails | null> {
  const result = await database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      // #225 (stage 3 of the #222 epic) — the client-facing DTO's git state comes from the
      // LEADING REPO ROW, not the workspace mirror columns. `coalesce` keeps the columns as a
      // fallback while stage 4 has not dropped them: a workspace created before migration
      // 0110, or one whose row a dual-write missed, still projects correctly (and `leadingRef`
      // read-repairs it on its next read). Once the columns go, the fallback goes with them
      // and nothing downstream notices, which is the whole point of doing this first.
      branch: sql<string | null>`coalesce(${leadingRepo.branch}, ${workspaces.branch})`,
      workingDir: sql<string | null>`coalesce(${leadingRepo.worktreePath}, ${workspaces.workingDir})`,
      baseBranch: sql<string | null>`coalesce(${leadingRepo.baseBranch}, ${workspaces.baseBranch})`,
      isDirect: workspaces.isDirect,
      planMode: workspaces.planMode,
      includeVisualProof: workspaces.includeVisualProof,
      requiresReview: workspaces.requiresReview,
      thoroughReview: workspaces.thoroughReview,
      readyForMerge: workspaces.readyForMerge,
      status: workspaces.status,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      skillId: workspaces.skillId,
      contextPrimer: workspaces.contextPrimer,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      scorecardScore: workspaces.scorecardScore,
      latestSetupCommand: workspaces.latestSetupCommand,
      latestSetupState: workspaces.latestSetupState,
      latestSetupStartedAt: workspaces.latestSetupStartedAt,
      latestSetupEndedAt: workspaces.latestSetupEndedAt,
      latestSetupExitCode: workspaces.latestSetupExitCode,
      latestSetupDurationMs: workspaces.latestSetupDurationMs,
      latestSetupStdoutTail: workspaces.latestSetupStdoutTail,
      latestSetupStderrTail: workspaces.latestSetupStderrTail,
      latestSymlinkState: workspaces.latestSymlinkState,
      latestSymlinkStartedAt: workspaces.latestSymlinkStartedAt,
      latestSymlinkEndedAt: workspaces.latestSymlinkEndedAt,
      latestSymlinkDirs: workspaces.latestSymlinkDirs,
      latestSymlinkLinked: workspaces.latestSymlinkLinked,
      latestSymlinkSkipped: workspaces.latestSymlinkSkipped,
      latestSymlinkFailed: workspaces.latestSymlinkFailed,
      latestSymlinkError: workspaces.latestSymlinkError,
      serviceState: workspaces.serviceState,
      isolationDowngraded: workspaces.isolationDowngraded,
      isolationDowngradeReason: workspaces.isolationDowngradeReason,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      issueTitle: issues.title,
      issuePriority: issues.priority,
      skillName: agentSkills.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
    .leftJoin(leadingRepo, and(eq(leadingRepo.workspaceId, workspaces.id), eq(leadingRepo.isLeading, true)))
    .where(eq(workspaces.id, workspaceId));

  if (result.length === 0) return null;

  const row = result[0];

  const sess = await firstRow(
    database
      .select({
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        triggerType: sessions.triggerType,
        stats: sessions.stats,
      })
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(1)
  );

  return mapWorkspaceDetailsRow(row, sess);
}

/** The most-recently-updated workspace for an issue (or null). */
export async function getLatestWorkspaceForIssue(
  issueId: string,
  database: Database = db,
): Promise<Workspace | null> {
  return firstRow(
    database
      .select()
      .from(workspaces)
      .where(eq(workspaces.issueId, issueId))
      .orderBy(desc(workspaces.updatedAt))
      .limit(1)
  );
}

/** Count of globally-active workspaces (status = "active"), across all projects. */
export async function getActiveWorkspaceCount(database: Database = db): Promise<number> {
  const rows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.status, "active"));
  return rows.length;
}

/** All workspaces in the "closed" state (across projects). */
export async function getClosedWorkspaces(database: Database = db) {
  return database.select().from(workspaces).where(eq(workspaces.status, "closed"));
}

/** {issueId, projectId, issueNumber} for a workspace (joined to its issue), or null. */
export async function getWorkspaceIssueContext(workspaceId: string, database: Database = db) {
  return firstRow(
    database
      .select({ issueId: workspaces.issueId, projectId: issues.projectId, issueNumber: issues.issueNumber })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
  );
}

/**
 * AK-535 terminal-move guard: the open, non-direct, unmerged workspace for an
 * issue (or null). Open = status != "closed" (a merged workspace is closed);
 * direct workspaces (isDirect=true) commit straight to the default branch — no
 * branch to strand — so they are excluded. Moving an issue to a terminal status
 * while such a workspace exists strands the branch (silent merge loss). The guard
 * QUERY now lives in the shared `issue-status-orchestration` seam so the
 * status-write transports (MCP move/update, server PATCH, CLI move) share ONE
 * implementation (arch-review #974); this thin wrapper keeps the existing
 * `(issueId, database)` call signature for server callers.
 */
export async function findOpenUnmergedWorkspace(
  issueId: string,
  database: Database = db,
): Promise<{ id: string; branch: string } | null> {
  return findOpenUnmergedWorkspaceShared(database, issueId);
}

/**
 * Live (non-closed) workspaces already holding a branch (#394).
 *
 * Git allows exactly one worktree per branch, so a second workspace created on the same branch
 * adopts the first one's directory and can never own it. Measured on eventhub as two pairs of
 * workspaces sharing one worktree path each, all four born `blocked`.
 */
export async function findLiveWorkspacesOnBranch(
  branch: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      status: workspaces.status,
      workingDir: workspaces.workingDir,
      issueId: workspaces.issueId,
    })
    .from(workspaces)
    .where(and(
      eq(workspaces.branch, branch),
      ne(workspaces.status, "closed"),
    ))
    .limit(3);
}

/**
 * Working directories still held by a NON-TERMINAL workspace (#699).
 *
 * This is the DB half of the answer `createWorktree` needs before it recursively deletes
 * a directory it has decided is a "leftover". Its own guards ask git, and git is the
 * authority that has already failed in the case that matters — a live worktree whose
 * `.git` file is unreadable is unregistered and therefore indistinguishable from an
 * abandoned directory. A workspace row is not: it names the path and says it is live.
 *
 * Terminal rows are deliberately excluded — a merged/closed workspace's worktree IS a
 * leftover, and that is the case the cleanup exists to handle.
 */
export async function listLiveWorkspaceWorkingDirs(database: Database = db) {
  const rows = await database
    .select({ workingDir: workspaces.workingDir })
    .from(workspaces)
    .where(
      and(
        isNotNull(workspaces.workingDir),
        notInArray(workspaces.status, TERMINAL_WORKSPACE_STATUSES as unknown as string[]),
      ),
    );
  return rows.map((r) => r.workingDir).filter((d): d is string => !!d);
}
