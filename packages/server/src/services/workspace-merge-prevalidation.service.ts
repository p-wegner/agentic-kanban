import { eq } from "drizzle-orm";
import { preferences, projects, workspaces } from "@agentic-kanban/shared/schema";
import { OPENSPEC_CHANGES_DIR, OPENSPEC_SPECS_DIR, validateOpenSpecChange } from "@agentic-kanban/shared/lib/openspec";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { teardownWorktree } from "./workspace-teardown.service.js";
import { moveIssueToDone, resolveProjectId, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { WorkspaceError, type GitService, type MergeResolutionState } from "./workspace-internals.js";

export type MergeWarning = { step: string; message: string; recoverable: true };

export type RecordMergeAttempt = (
  workspace: typeof workspaces.$inferSelect,
  eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed",
  body: string,
  payload?: Record<string, unknown>,
  createdAt?: string,
) => Promise<void>;

export type AddRecoverableWarning = (warnings: MergeWarning[], step: string, err: unknown) => void;
export type KillWorktreeProcesses = (workingDir: string | null | undefined, label: string) => Promise<void>;

export type PreMergeResolutionOutcome =
  | { kind: "completed"; result: Record<string, unknown> }
  | { kind: "proceed" };

export async function handleWorkspaceMergeResolution(args: {
  id: string;
  workspace: typeof workspaces.$inferSelect;
  project: typeof projects.$inferSelect | null;
  repoPath: string;
  baseBranch: string;
  resolution: MergeResolutionState;
  database: Database;
  boardEvents?: BoardEvents;
  gitService: GitService;
  killProcesses: (dir: string) => Promise<number>;
  killWorktreeProcesses: KillWorktreeProcesses;
  addRecoverableWarning: AddRecoverableWarning;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<PreMergeResolutionOutcome> {
  const { resolution } = args;
  switch (resolution.kind) {
    case "already-closed":
      throw new WorkspaceError("Workspace is already closed.", "CONFLICT", { mergeReason: "already_closed", status: resolution.status });
    case "not-approved":
      throw new WorkspaceError(
        "Workspace is not approved for merge. Mark it as ready-for-merge before merging.",
        "CONFLICT",
        { mergeReason: "not_approved", status: resolution.status },
      );
    case "already-merged":
      return { kind: "completed", result: await reconcileAlreadyMergedRetry(args) };
    case "direct-close":
      return { kind: "completed", result: await closeDirectWorkspace(args) };
    case "reconcile":
      return { kind: "completed", result: await reconcileAncestorWorkspace(args, resolution) };
    case "clean-ancestor":
      return { kind: "completed", result: await keepCleanAncestorInReview(args, resolution) };
    case "error-skip":
      throw resolution.error;
    case "conflict-ready":
      await recordConflictAndClearReadyFlag(args, resolution);
      throw resolution.error;
    case "proceed":
      return { kind: "proceed" };
  }
}

export async function loadMergePreferences(database: Database): Promise<Map<string, string>> {
  return new Map<string, string>(
    (await database.select().from(preferences)).map((r) => [r.key, r.value]),
  );
}

export async function runWorkspacePreMergeValidation(args: {
  workspace: typeof workspaces.$inferSelect;
  repoPath: string;
  baseBranch: string;
  gitService: GitService;
}): Promise<void> {
  const { workspace, repoPath, baseBranch, gitService } = args;
  if (!workspace.workingDir) return;

  await autoRenumberMigrations(workspace, repoPath, baseBranch, gitService);

  const specValidation = await validateOpenSpecChange(workspace.workingDir);
  if (specValidation.deltas.length === 0) return;

  const currentBranch = await gitService.getCurrentBranch(repoPath);
  if (currentBranch !== baseBranch) {
    throw new WorkspaceError(
      `Cannot apply OpenSpec deltas: main checkout HEAD is on '${currentBranch}' but this workspace targets '${baseBranch}'. ` +
        `Check out '${baseBranch}' in the main checkout before merging OpenSpec changes.`,
      "CONFLICT",
      { currentBranch, targetBranch: baseBranch },
    );
  }

  for (const warning of specValidation.warnings) {
    console.warn(`[workspace-merge] OpenSpec warning: ${warning}`);
  }
  await warnIfBaseChangedLivingSpecs(workspace, repoPath, baseBranch, gitService, specValidation.deltas.map((delta) => delta.domain));
  if (!specValidation.valid) {
    throw new WorkspaceError(
      `OpenSpec change is invalid: ${specValidation.errors.join("; ")}`,
      "BAD_REQUEST",
      { errors: specValidation.errors, warnings: specValidation.warnings },
    );
  }
}

async function reconcileAlreadyMergedRetry(args: {
  id: string;
  workspace: typeof workspaces.$inferSelect;
  project: typeof projects.$inferSelect | null;
  repoPath: string;
  database: Database;
  boardEvents?: BoardEvents;
  gitService: GitService;
  killProcesses: (dir: string) => Promise<number>;
  killWorktreeProcesses: KillWorktreeProcesses;
  addRecoverableWarning: AddRecoverableWarning;
  recordMergeAttempt: RecordMergeAttempt;
}) {
  const { id, workspace, project, repoPath, database, boardEvents, gitService, addRecoverableWarning } = args;
  const warnings: MergeWarning[] = [];
  if (workspace.workingDir && !workspace.isDirect) {
    await teardownWorktree(
      {
        workingDir: workspace.workingDir,
        branch: workspace.branch,
        isDirect: workspace.isDirect,
        teardownScript: project?.teardownScript,
        setupEnabled: project?.setupEnabled,
        label: "merge:already-merged",
      },
      { killDir: args.killProcesses },
    );
    await args.killWorktreeProcesses(workspace.workingDir, "merge:already-merged");
    try {
      await gitService.removeWorktree(repoPath, workspace.workingDir);
    } catch (err) {
      addRecoverableWarning(warnings, "remove-worktree", err);
    }
  }

  try {
    await gitService.deleteBranch(repoPath, workspace.branch);
    console.log(`[workspace-service] deleted branch ${workspace.branch}`);
  } catch (err) {
    addRecoverableWarning(warnings, "delete-branch", err);
  }

  const now = new Date().toISOString();
  await updateWorkspaceStatus(id, "closed", {
    workingDir: null,
    closedAt: workspace.closedAt ?? now,
    mergedAt: workspace.mergedAt,
    readyForMerge: false,
  }, database);
  await moveIssueToDone(id, workspace.issueId, now, database);

  const projectId = await resolveProjectId(id, database);
  if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
  await args.recordMergeAttempt(
    workspace,
    "already-merged",
    `Merge already recorded for workspace ${id} at ${workspace.mergedAt}. Reconciled cleanup and issue status.`,
    { mergedAt: workspace.mergedAt, warnings },
    now,
  );

  return {
    id,
    mergeOutput: `Workspace was already marked as merged at ${workspace.mergedAt}; reconciled without requiring branch ref.`,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function closeDirectWorkspace(args: {
  id: string;
  workspace: typeof workspaces.$inferSelect;
  database: Database;
  boardEvents?: BoardEvents;
  recordMergeAttempt: RecordMergeAttempt;
}) {
  const { id, workspace, database, boardEvents } = args;
  const now = new Date().toISOString();
  await computeWorkspaceCodeMetrics(id, database).catch(() => null);
  await updateWorkspaceStatus(id, "closed", { closedAt: now, readyForMerge: false }, database);
  await moveIssueToDone(id, workspace.issueId, now, database, true);

  const projectId = await resolveProjectId(id, database);
  if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
  await args.recordMergeAttempt(
    workspace,
    "direct-closed",
    `Direct workspace ${id} was closed without a branch merge.`,
    { closedAt: now },
    now,
  );

  return { id, mergeOutput: "Direct workspace closed (no merge needed)" };
}

async function reconcileAncestorWorkspace(
  args: {
    id: string;
    workspace: typeof workspaces.$inferSelect;
    database: Database;
    boardEvents?: BoardEvents;
    baseBranch: string;
    recordMergeAttempt: RecordMergeAttempt;
  },
  resolution: Extract<MergeResolutionState, { kind: "reconcile" }>,
) {
  const { id, workspace, database, boardEvents, baseBranch } = args;
  const { branchSha, baseSha, uniqueCommits } = resolution;
  const now = new Date().toISOString();
  console.log(
    `[workspace-merge] auto-Done audit: ws=${id} baseSha=${baseSha} branchSha=${branchSha} uniqueCommits=${uniqueCommits} reconciledAt=${now}`,
  );
  await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now, mergedAt: now, readyForMerge: false }, database);
  await moveIssueToDone(id, workspace.issueId, now, database);
  await args.recordMergeAttempt(
    workspace,
    "merged",
    `Branch '${workspace.branch}' tip (${branchSha}) is already an ancestor of ${baseBranch} — reconciled as already-merged no-op.`,
    { targetBranch: baseBranch, commitSha: branchSha, mergedAt: now, uniqueCommitCount: uniqueCommits },
    now,
  );
  const projectId = await resolveProjectId(id, database);
  if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
  return {
    id,
    merged: false,
    reconciled: true,
    baseBranch,
    baseHeadShaBefore: baseSha,
    baseHeadShaAfter: baseSha,
    mergeOutput: `Branch '${workspace.branch}' was already fully merged into ${baseBranch} (tip ${branchSha} is an ancestor). Reconciled as successful no-op.`,
  };
}

async function keepCleanAncestorInReview(
  args: {
    id: string;
    workspace: typeof workspaces.$inferSelect;
    database: Database;
    baseBranch: string;
  },
  resolution: Extract<MergeResolutionState, { kind: "clean-ancestor" }>,
) {
  const { id, workspace, database, baseBranch } = args;
  const { branchSha, baseSha, uniqueCommits } = resolution;
  const now = new Date().toISOString();
  console.log(
    `[workspace-merge] 0-commit ancestor guard: ws=${id} branchSha=${branchSha} baseSha=${baseSha} uniqueCommits=${uniqueCommits} ` +
      "refrain from merge, keep workspace in review.",
  );
  await database.update(workspaces).set({ readyForMerge: false, updatedAt: now }).where(eq(workspaces.id, id));
  return {
    id,
    merged: false,
    reconciled: false,
    baseBranch,
    baseHeadShaBefore: baseSha,
    baseHeadShaAfter: baseSha,
    mergeOutput: `Branch '${workspace.branch}' has no unique commits relative to ${baseBranch}. Merge skipped as a false-positive guard.`,
  };
}

async function recordConflictAndClearReadyFlag(
  args: {
    id: string;
    workspace: typeof workspaces.$inferSelect;
    database: Database;
    baseBranch: string;
    recordMergeAttempt: RecordMergeAttempt;
  },
  resolution: Extract<MergeResolutionState, { kind: "conflict-ready" }>,
) {
  const { id, workspace, database, baseBranch } = args;
  try {
    await database.update(workspaces).set({ readyForMerge: false, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, id));
  } catch (dbErr) {
    console.warn("[workspace-merge] failed to clear stale readyForMerge flag:", dbErr instanceof Error ? dbErr.message : String(dbErr));
  }

  const { conflictFiles, behindCount } = resolution;
  if (behindCount) {
    await args.recordMergeAttempt(
      workspace,
      "conflict",
      `Merge blocked: branch ${workspace.branch} was ${behindCount} commit(s) behind ${baseBranch} and rebase found conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}. readyForMerge cleared.`,
      { targetBranch: baseBranch, conflictingFiles: conflictFiles, behindCount },
    );
    return;
  }

  await args.recordMergeAttempt(
    workspace,
    "conflict",
    `Merge attempt blocked by conflicts in ${conflictFiles.length} file${conflictFiles.length === 1 ? "" : "s"}: ${conflictFiles.join(", ")}`,
    { targetBranch: baseBranch, conflictingFiles: conflictFiles },
  );
}

async function autoRenumberMigrations(
  workspace: typeof workspaces.$inferSelect,
  repoPath: string,
  baseBranch: string,
  gitService: GitService,
): Promise<void> {
  if (!workspace.workingDir) return;
  try {
    const renumber = await gitService.autoRenumberMigrations(workspace.workingDir, repoPath, baseBranch);
    if (renumber.renumbered) {
      console.log(
        `[workspace-merge] auto-renumbered migrations on ${workspace.branch}: ` +
          renumber.renames.map((r) => `${r.from}→${r.to}`).join(", "),
      );
    }
  } catch (err) {
    console.warn(
      "[workspace-merge] migration auto-renumber failed (continuing to conflict check):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function warnIfBaseChangedLivingSpecs(
  workspace: typeof workspaces.$inferSelect,
  repoPath: string,
  baseBranch: string,
  gitService: GitService,
  domains: string[],
): Promise<void> {
  if (!workspace.baseCommitSha || typeof gitService.getChangedFilesBetween !== "function") return;
  const baseSpecChanges = await gitService.getChangedFilesBetween(repoPath, workspace.baseCommitSha, baseBranch);
  for (const domain of new Set(domains)) {
    if (baseSpecChanges.includes(`${OPENSPEC_SPECS_DIR}/${domain}/spec.md`)) {
      console.warn(
        `[workspace-merge] OpenSpec warning: '${domain}' changed on ${baseBranch} since this workspace branched; review the living spec merge carefully.`,
      );
    }
  }
}

export const OPEN_SPEC_PREMERGE_PATHS = [OPENSPEC_SPECS_DIR, OPENSPEC_CHANGES_DIR] as const;
