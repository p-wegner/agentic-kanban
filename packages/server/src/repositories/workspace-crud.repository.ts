import { issues, projects, workspaces, sessions, agentSkills, projectStatuses, issueDependencies, workflowNodes } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { TERMINAL_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-liveness";
import { eq, inArray, notInArray, and, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";
import { setWorkspaceWorkingDir as setWorkspaceWorkingDirShared } from "@agentic-kanban/shared/lib/workspace-git-state";
import { getAllPreferences as canonicalGetAllPreferences } from "./preferences.repository.js";

export async function updateLatestSetupRunFields(
  workspaceId: string,
  run: {
    command: string | null;
    state: string;
    startedAt: string | null;
    endedAt: string | null;
    exitCode: number | null;
    durationMs: number | null;
    stdoutTail: string | null;
    stderrTail: string | null;
  },
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({
      latestSetupCommand: run.command,
      latestSetupState: run.state,
      latestSetupStartedAt: run.startedAt,
      latestSetupEndedAt: run.endedAt,
      latestSetupExitCode: run.exitCode,
      latestSetupDurationMs: run.durationMs,
      latestSetupStdoutTail: run.stdoutTail,
      latestSetupStderrTail: run.stderrTail,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaces.id, workspaceId));
}

export async function getIssueForWorkspaceCreate(
  issueId: string,
  database: Database = db,
) {
  return database
    // `externalKey` rides along because a plugin-loop unit ticket is only RECOGNISABLE by it
    // (`plugin-loop:<slug>:<loop>:<unit>`, #201 debt) and the skill such a ticket must launch with
    // comes from the loop's manifest entry, not from the project default (#321).
    .select({ projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title, description: issues.description, priority: issues.priority, externalKey: issues.externalKey })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function getProjectForWorkspaceCreate(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project
    ? [{
        repoPath: project.repoPath,
        defaultBranch: project.defaultBranch,
        defaultSkillId: project.defaultSkillId,
        setupScript: project.setupScript,
        setupBlocking: project.setupBlocking,
        setupEnabled: project.setupEnabled,
        symlinkEnabled: project.symlinkEnabled,
        symlinkDirs: project.symlinkDirs,
        servicesConfig: project.servicesConfig ?? null,
      }]
    : [];
}

export async function getAgentSkillById(
  skillId: string,
  database: Database = db,
) {
  return database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

/** #613: delegates to the canonical reader — see preferences.repository. */
export async function getAllPreferences(database: Database = db) {
  return canonicalGetAllPreferences(database);
}

export async function insertWorkspaceRecordRow(
  values: typeof workspaces.$inferInsert,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

/**
 * Ticket groups (#661): open (non-closed) workspaces LEADING any of the given issues.
 * Used to validate group members at create time — a member already served by its own
 * live workspace must not join a group too (two agents on one ticket).
 */
export async function findOpenWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
) {
  if (issueIds.length === 0) return [];
  return database
    .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, status: workspaces.status })
    .from(workspaces)
    .where(and(inArray(workspaces.issueId, issueIds), ne(workspaces.status, "closed")));
}

export async function findOpenDirectWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(and(
      eq(workspaces.issueId, issueId),
      eq(workspaces.isDirect, true),
      ne(workspaces.status, "closed"),
    ))
    .limit(3);
}

// #502: one definition, in issue.repository. This copy returned the raw ROW ARRAY,
// so its caller unpacked a list that never had more than one element.
export { getIssueProjectId } from "./issue.repository.js";

export async function updateWorkspaceLaunchFailure(
  workspaceId: string,
  values: { status: string; latestLaunchError: string; updatedAt: string },
  database: Database = db,
) {
  return setWorkspaceStatus(database, workspaceId, values.status as WorkspaceStatus, {
    now: values.updatedAt,
    set: { latestLaunchError: values.latestLaunchError },
  });
}

export async function getSessionsForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, status: sessions.status, pid: sessions.pid })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function getWorkspaceDeletionContext(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({
      workingDir: workspaces.workingDir,
      isDirect: workspaces.isDirect,
      branch: workspaces.branch,
      repoPath: projects.repoPath,
      projectId: issues.projectId,
      teardownScript: projects.teardownScript,
      setupEnabled: projects.setupEnabled,
      serviceState: workspaces.serviceState,
    })
    .from(workspaces)
    .leftJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function findWorkspacesByWorkingDir(
  workingDir: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.workingDir, workingDir));
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

export async function getSessionStatusesForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function updateWorkspaceClosed(
  workspaceId: string,
  values: {
    status: "closed";
    workingDir: string | null;
    closedAt: string;
    updatedAt: string;
    /** Set when the worktree could not be cleanly removed (#268) — surfaces in the Cleanup Queue. */
    cleanupWarning?: string | null;
  },
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, "closed", {
    now: values.updatedAt,
    set: {
      closedAt: values.closedAt,
      ...(values.cleanupWarning !== undefined ? { cleanupWarning: values.cleanupWarning } : {}),
    },
  });
  // #226 — `workingDir` is a leading-repo MIRROR column, so it must go through the writer that
  // updates the `repos` row too. `setWorkspaceStatus` lives in packages/shared and cannot reach
  // the mirror, which is why its `set` no longer accepts these columns at all.
  await setWorkspaceWorkingDirShared(database, workspaceId, values.workingDir, values.updatedAt);
}

export async function getWorkspaceIssueId(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function setWorkspaceReadyForMerge(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ readyForMerge: true, updatedAt: now }).where(eq(workspaces.id, workspaceId));
}

export async function getIssueProjectIdById(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function setWorkspaceWorkingDir(
  workspaceId: string,
  values: { workingDir: string; baseBranch: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, workspaceId));
  await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { workingDir: values.workingDir, baseBranch: values.baseBranch }, database);
}

/**
 * Generic PATCH-style workspace update backing `PATCH /api/workspaces/:id`. `updates` is
 * a caller-assembled bag of optional columns; when it carries `status`, route the write
 * through the `setWorkspaceStatus` authority (terminal-invariant guard included) with the
 * remaining columns applied atomically via `opts.set`, instead of a raw update that could
 * revive a closed+merged workspace.
 */
export async function applyWorkspaceUpdates(
  workspaceId: string,
  updates: Record<string, unknown>,
  database: Database = db,
): Promise<void> {
  const { status, updatedAt, ...rest } = updates;
  // Dual-write (#222 stage 2): forward any of the five git-state columns in the PATCH bag
  // onto the leading-repo row. Nested — it exists only for this function's two branches.
  const mirrorGitColumnsFromPatch = async (patch: Record<string, unknown>) => {
    const forward: Parameters<typeof mirrorWorkspaceColumnsToLeadingRepo>[1] = {};
    if ("branch" in patch) forward.branch = patch.branch as string | null;
    if ("workingDir" in patch) forward.workingDir = patch.workingDir as string | null;
    if ("baseBranch" in patch) forward.baseBranch = patch.baseBranch as string | null;
    if ("baseCommitSha" in patch) forward.baseCommitSha = patch.baseCommitSha as string | null;
    if ("mergedHeadSha" in patch) forward.mergedHeadSha = patch.mergedHeadSha as string | null;
    if (Object.keys(forward).length === 0) return;
    await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, forward, database);
  };
  if (status !== undefined) {
    await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, {
      now: updatedAt as string | undefined,
      set: rest,
    });
    await mirrorGitColumnsFromPatch(rest);
    return;
  }
  await database.update(workspaces).set(updates).where(eq(workspaces.id, workspaceId));
  await mirrorGitColumnsFromPatch(updates);
}

export async function listStaleWorktreeRows(
  projectId: string | undefined,
  database: Database = db,
) {
  const conditions = [eq(workspaces.status, "closed")];
  if (projectId) {
    conditions.push(eq(issues.projectId, projectId));
  }
  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      updatedAt: workspaces.updatedAt,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      projectId: issues.projectId,
      repoPath: projects.repoPath,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(whereClause);
}

/**
 * Clear a workspace's `workingDir` on BOTH sides — the column and the leading `repos` row
 * (#226).
 *
 * The only sanctioned way to clear it. `setWorkspaceStatus`'s `set` escape hatch used to be
 * the other way and could not mirror, so four close paths left the row pointing at a
 * torn-down worktree; its type now rejects these columns outright, which routes them here.
 */
export async function clearWorkspaceWorkingDir(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceWorkingDirShared(database, workspaceId, null, now);
}

export async function getAgentSkillNameById(
  skillId: string,
  database: Database = db,
) {
  return database.select({ id: agentSkills.id, name: agentSkills.name }).from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

export async function findExistingWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id, status: workspaces.status, branch: workspaces.branch, isDirect: workspaces.isDirect })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));
}

export async function getDependenciesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.issueId, issueId),
      ),
    );
}

export async function getBlockerIssues(
  blockerIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, blockerIds));
}

export async function listCleanupWarningRows(
  projectId: string | undefined,
  database: Database = db,
) {
  const conditions = [
    eq(workspaces.status, "closed"),
    isNotNull(workspaces.cleanupWarning),
    ne(workspaces.cleanupWarning, ""),
  ];
  if (projectId) {
    conditions.push(eq(issues.projectId, projectId));
  }
  const whereClause = and(...conditions);

  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      cleanupWarning: workspaces.cleanupWarning,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      updatedAt: workspaces.updatedAt,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(whereClause);
}

export async function clearWorkspaceCleanupWarning(
  workspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces)
    .set({ cleanupWarning: null, updatedAt: now })
    .where(eq(workspaces.id, workspaceId));
}
