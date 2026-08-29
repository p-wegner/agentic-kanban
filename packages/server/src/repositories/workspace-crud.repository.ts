import { issues, projects, workspaces, sessions, agentSkills, projectStatuses, issueDependencies, workflowNodes } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq, inArray, and, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";
import { setWorkspaceWorkingDir as setWorkspaceWorkingDirShared } from "@agentic-kanban/shared/lib/workspace-git-state";
import { getAllPreferences as canonicalGetAllPreferences } from "./preferences.repository.js";
import { issueIdentityColumns } from "./projections.js";
import { updateWorkspaceSetupRun } from "./workspace-setup-run.repository.js";

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
  // #815: the eight `latest_setup_*` columns moved to `workspace_setup_run`, owned by
  // `workspace-setup-run.repository.ts`. The workspace row still gets its `updatedAt` bump —
  // that was part of the same UPDATE and is observable behaviour elsewhere.
  await updateWorkspaceSetupRun(workspaceId, run, database);
  await database
    .update(workspaces)
    .set({ updatedAt: new Date().toISOString() })
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
  // #919: this issue now HAS a workspace, so any recorded "why the monitor did not start it"
  // is stale and must not keep answering that question. The monitor clears the records of the
  // issues IT started, but that only covers its own path — a manual start, a CLI start, or a
  // group member joining someone else's workspace would otherwise leave a ticket that is
  // running (and later Done) permanently badged "held for wip_cap". Cleared here, on the one
  // choke point every workspace insert goes through, and inside the caller's transaction so
  // the clear cannot outlive a rolled-back create.
  await database.update(issues)
    .set({ lastAutoStartSkipReason: null, lastAutoStartSkipAt: null })
    .where(eq(issues.id, values.issueId));
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

/**
 * Clear a previously-recorded launch-failure error (#895 follow-up): `updateWorkspaceLaunchFailure`
 * sets `latestLaunchError`, but nothing ever cleared it — and `workspace-launch-failures.service.ts`
 * checks it FIRST, ahead of session state, so a workspace that failed once and then completed a
 * session cleanly would still be reported as `preflight-failed` forever. Does not touch `status`,
 * so it is safe to call from a route that already owns the status transition itself.
 */
export async function clearWorkspaceLaunchError(workspaceId: string, database: Database = db): Promise<void> {
  await database.update(workspaces).set({ latestLaunchError: null }).where(eq(workspaces.id, workspaceId));
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

/*
 * `findWorkspacesByWorkingDir` was removed in #735.
 *
 * It was the co-residency question — "who else points at this directory?" — and it answered
 * it with `eq(working_dir, ...)`, which on Windows misses a row stored with different
 * separators or drive-letter casing. A miss there is the unrecoverable direction: it reads as
 * "nothing claims this" and the caller recursive-deletes a live agent's checkout. #713 moved
 * that question into `findLiveWorktreeSharers` (`@agentic-kanban/shared/lib/worktree-claim`),
 * which compares with `samePath` and filters with `holdsLiveResources`, and #735 converted the
 * last three callers of the raw delete — leaving this with zero non-test callers.
 *
 * Ask the guard, not the table: `removeWorktreeUnlessShared` for a removal,
 * `findLiveWorktreeSharers` / `findLiveBranchHolders` to just ask.
 */

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
      ...issueIdentityColumns,
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
