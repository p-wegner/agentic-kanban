import { applyOpenSpecDeltas, OPENSPEC_CHANGES_DIR, OPENSPEC_SPECS_DIR } from "@agentic-kanban/shared/lib/openspec";
import type { Database } from "../db/index.js";
import { persistWorkspaceCleanupWarning, getWorkspaceById } from "../repositories/workspace-merge-cleanup.repository.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import type { GitService } from "./workspace-internals.js";
import { teardownWorktree } from "./workspace-teardown.service.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { generateAndPersistGithubHandoffDraft } from "./github-handoff-draft.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { autoStartUnblockedDependencyIssue } from "./dependency-auto-chain.service.js";
import { rebuildSharedIfChanged, runLearningStep } from "./merge-helpers.service.js";
import type { MergeWarning } from "./workspace-merge-prevalidation.service.js";
import { applyDeferredWorkingTreeSync } from "@agentic-kanban/shared/lib/git-service";

export type WorkspacePostMergeCleanupArgs = {
  workspaceId: string;
  issueId: string;
  repoPath: string;
  preMergeHead: string;
  prefMap: Map<string, string>;
  projectId: string | null;
  workingDir: string | null | undefined;
  branch: string;
  mergeResult: string;
  teardownScript: string | null;
  setupEnabled: boolean;
  isDirect: boolean;
  /** SHA returned by mergeBranch({ deferWorkingTreeSync: true }) — apply before any other cleanup. */
  pendingWorkingTreeSyncSha?: string | null;
};

export async function runWorkspacePostMergeCleanup(
  args: WorkspacePostMergeCleanupArgs,
  deps: {
    database: Database;
    gitService: GitService;
    killProcesses: (dir: string) => Promise<number>;
    getSessionManager?: () => SessionManager;
    boardEvents?: BoardEvents;
  },
): Promise<void> {
  const warnings: MergeWarning[] = [];
  let mergeResult = args.mergeResult;

  // Apply the deferred working-tree sync FIRST — before teardown frees the worktree —
  // so git reset --hard runs after the HTTP response is already flushed and tsx
  // hot-reload can no longer drop the in-flight connection.
  if (args.pendingWorkingTreeSyncSha) {
    try {
      await applyDeferredWorkingTreeSync(args.repoPath, args.pendingWorkingTreeSyncSha);
    } catch (err) {
      console.warn("[workspace-merge] deferred working-tree sync failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }

  await teardownMergedWorktree(args, deps, warnings);
  await collectCodeMetrics(args, deps.database, warnings);
  mergeResult = await applyOpenSpecPostMerge(args, deps, warnings, mergeResult);
  await removeWorktreeDirectory(args, deps, warnings);
  await deleteMergedBranch(args, deps, warnings);
  await recordCleanupWarnings(args, deps.database, warnings);

  const postMergeChangedFiles = await getPostMergeChangedFiles(args, deps.gitService);
  await createGithubHandoffDraft(args, deps, postMergeChangedFiles);
  await rebuildSharedDist(args.repoPath, postMergeChangedFiles);
  await runPostMergeLearningStep(args, deps);
  await maybeAutoStartFollowups(args, deps);
  await maybeAutoStartUnblockedDependency(args, deps);
  void mergeResult;
}

async function teardownMergedWorktree(
  args: WorkspacePostMergeCleanupArgs,
  deps: { killProcesses: (dir: string) => Promise<number> },
  warnings: MergeWarning[],
): Promise<void> {
  if (!args.workingDir || args.isDirect) return;
  try {
    await teardownWorktree(
      {
        workingDir: args.workingDir,
        branch: args.branch,
        isDirect: false,
        teardownScript: args.teardownScript ?? undefined,
        setupEnabled: args.setupEnabled,
        label: "merge",
      },
      { killDir: deps.killProcesses },
    );
  } catch (err) {
    addRecoverableWarning(warnings, "teardown-worktree", err);
  }
}

async function collectCodeMetrics(
  args: WorkspacePostMergeCleanupArgs,
  database: Database,
  warnings: MergeWarning[],
): Promise<void> {
  if (!args.workingDir) return;
  await computeWorkspaceCodeMetrics(args.workspaceId, database).catch((err) => {
    addRecoverableWarning(warnings, "code-metrics", err);
  });
}

async function applyOpenSpecPostMerge(
  args: WorkspacePostMergeCleanupArgs,
  deps: { database: Database; gitService: GitService },
  warnings: MergeWarning[],
  mergeResult: string,
): Promise<string> {
  try {
    const changedFiles = args.preMergeHead
      ? await getChangedFilesBetweenSafe(args.repoPath, args.preMergeHead, "HEAD", deps.gitService)
      : [];
    const specChangeIds = findOpenSpecChangeIds(changedFiles);
    const appliedCount = await applyOpenSpecChangeIds(args.repoPath, specChangeIds);
    if (appliedCount === 0) return mergeResult;

    const committed = await commitOpenSpecPaths(args.repoPath, args.branch, deps.gitService);
    const openSpecNote = `OpenSpec: applied ${appliedCount} domain delta(s)${committed ? " and committed living specs" : ""}.`;
    await recordOpenSpecNote(args, deps.database, openSpecNote, appliedCount, committed);
    return `${mergeResult}\n${openSpecNote}`;
  } catch (err) {
    addRecoverableWarning(warnings, "openspec-post-merge", err);
    return mergeResult;
  }
}

async function removeWorktreeDirectory(
  args: WorkspacePostMergeCleanupArgs,
  deps: { database: Database; gitService: GitService },
  warnings: MergeWarning[],
): Promise<void> {
  if (!args.workingDir) return;
  try {
    await deps.gitService.removeWorktree(args.repoPath, args.workingDir);
  } catch (err) {
    addRecoverableWarning(warnings, "remove-worktree", err);
    const warningMsg = err instanceof Error ? err.message : String(err);
    try {
      await persistWorkspaceCleanupWarning(args.workspaceId, warningMsg, args.workingDir, deps.database);
    } catch (dbErr) {
      console.warn("[workspace-merge] failed to persist cleanup warning:", dbErr instanceof Error ? dbErr.message : String(dbErr));
    }
  }
}

async function deleteMergedBranch(
  args: WorkspacePostMergeCleanupArgs,
  deps: { gitService: GitService },
  warnings: MergeWarning[],
): Promise<void> {
  try {
    await deps.gitService.deleteBranch(args.repoPath, args.branch);
    console.log(`[workspace-service] deleted branch ${args.branch}`);
  } catch (err) {
    addRecoverableWarning(warnings, "delete-branch", err);
  }
}

async function recordCleanupWarnings(
  args: WorkspacePostMergeCleanupArgs,
  database: Database,
  warnings: MergeWarning[],
): Promise<void> {
  if (warnings.length === 0) return;
  try {
    const workspace = await getWorkspaceById(args.workspaceId, database);
    if (!workspace) return;
    await insertIssueComment({
      issueId: workspace.issueId,
      workspaceId: args.workspaceId,
      kind: "merge-attempt",
      author: "system",
      body: `Merge completed, but ${warnings.length} post-merge cleanup step${warnings.length === 1 ? "" : "s"} reported a recoverable warning. The branch was already merged before this response returned.`,
      payload: { eventType: "warning", workspaceId: args.workspaceId, branch: args.branch, warnings },
      createdAt: new Date().toISOString(),
    }, database);
  } catch (err) {
    console.warn("[workspace-merge] failed to record post-merge cleanup warnings:", err instanceof Error ? err.message : String(err));
  }
}

async function getPostMergeChangedFiles(
  args: WorkspacePostMergeCleanupArgs,
  gitService: GitService,
): Promise<string[]> {
  if (!args.preMergeHead) return [];
  try {
    return await gitService.getChangedFilesBetween(args.repoPath, args.preMergeHead, "HEAD");
  } catch (err) {
    console.warn("[workspace-merge] getChangedFilesBetween failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function createGithubHandoffDraft(
  args: WorkspacePostMergeCleanupArgs,
  deps: { database: Database; gitService: GitService },
  postMergeChangedFiles: string[],
): Promise<void> {
  if (!args.preMergeHead) return;
  try {
    const commits = typeof deps.gitService.getCommitSummariesBetween === "function"
      ? await deps.gitService.getCommitSummariesBetween(args.repoPath, args.preMergeHead, "HEAD")
      : [];
    await generateAndPersistGithubHandoffDraft({
      workspaceId: args.workspaceId,
      issueId: args.issueId,
      database: deps.database,
      repoPath: args.repoPath,
      fromRef: args.preMergeHead,
      toRef: "HEAD",
      changedFiles: postMergeChangedFiles,
      commits,
      gitService: deps.gitService,
    });
  } catch (err) {
    console.warn("[workspace-merge] post-merge handoff draft failed:", err instanceof Error ? err.message : String(err));
  }
}

async function rebuildSharedDist(repoPath: string, postMergeChangedFiles: string[]): Promise<void> {
  try {
    await rebuildSharedIfChanged(repoPath, postMergeChangedFiles);
  } catch (err) {
    console.warn("[workspace-merge] shared dist rebuild failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

async function runPostMergeLearningStep(
  args: WorkspacePostMergeCleanupArgs,
  deps: { database: Database; getSessionManager?: () => SessionManager },
): Promise<void> {
  try {
    if (deps.getSessionManager) {
      await runLearningStep(args.workspaceId, args.prefMap, deps.database, deps.getSessionManager);
    }
  } catch (err) {
    console.warn("[workspace-merge] post-merge learning step failed:", err);
  }
}

async function maybeAutoStartFollowups(
  args: WorkspacePostMergeCleanupArgs,
  deps: { database: Database; getSessionManager?: () => SessionManager; boardEvents?: BoardEvents },
): Promise<void> {
  try {
    if (args.prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && args.projectId && deps.getSessionManager) {
      await autoStartFollowups(args.issueId, args.projectId, deps.database, deps.getSessionManager, args.prefMap, { boardEvents: deps.boardEvents });
    }
  } catch (err) {
    console.warn("[workspace-merge] auto_start_followup check failed:", err);
  }
}

async function maybeAutoStartUnblockedDependency(
  args: WorkspacePostMergeCleanupArgs,
  deps: {
    database: Database;
    gitService: GitService;
    getSessionManager?: () => SessionManager;
    boardEvents?: BoardEvents;
  },
): Promise<void> {
  try {
    await autoStartUnblockedDependencyIssue({
      database: deps.database,
      projectId: args.projectId,
      completedIssueId: args.issueId,
      prefMap: args.prefMap,
      getSessionManager: deps.getSessionManager,
      boardEvents: deps.boardEvents,
      gitService: deps.gitService,
    });
  } catch (err) {
    console.warn("[workspace-merge] dependency auto-chain check failed:", err);
  }
}

function findOpenSpecChangeIds(changedFiles: string[]): string[] {
  return [...new Set(changedFiles
    .map((file) => file.match(/^openspec\/changes\/([^/]+)\/specs\/[^/]+\/spec\.md$/)?.[1])
    .filter((sid): sid is string => !!sid))];
}

async function applyOpenSpecChangeIds(repoPath: string, specChangeIds: string[]): Promise<number> {
  let appliedCount = 0;
  for (const changeId of specChangeIds) {
    const specResult = await applyOpenSpecDeltas(repoPath, changeId, { removeAppliedDeltas: true });
    if (!specResult.valid) {
      throw new Error(`OpenSpec change '${changeId}' is invalid: ${specResult.errors.join("; ")}`);
    }
    appliedCount += specResult.applied.length;
    for (const warning of specResult.warnings) {
      console.warn(`[workspace-merge] OpenSpec warning: ${warning}`);
    }
  }
  return appliedCount;
}

async function recordOpenSpecNote(
  args: WorkspacePostMergeCleanupArgs,
  database: Database,
  openSpecNote: string,
  appliedCount: number,
  committed: boolean,
): Promise<void> {
  try {
    await insertIssueComment({
      issueId: args.issueId,
      workspaceId: args.workspaceId,
      kind: "merge-attempt",
      author: "system",
      body: openSpecNote,
      payload: { eventType: "openspec-applied", workspaceId: args.workspaceId, branch: args.branch, appliedCount, committed },
      createdAt: new Date().toISOString(),
    }, database);
  } catch (dbErr) {
    console.warn("[workspace-merge] failed to record openspec note:", dbErr instanceof Error ? dbErr.message : String(dbErr));
  }
}

async function getChangedFilesBetweenSafe(
  repoPath: string,
  fromRef: string,
  toRef: string,
  gitService: GitService,
): Promise<string[]> {
  if (typeof gitService.getChangedFilesBetween !== "function") return [];
  return gitService.getChangedFilesBetween(repoPath, fromRef, toRef);
}

async function commitOpenSpecPaths(repoPath: string, branch: string, gitService: GitService): Promise<boolean> {
  if (typeof gitService.commitPaths !== "function") return false;
  return gitService.commitPaths(
    repoPath,
    [OPENSPEC_SPECS_DIR, OPENSPEC_CHANGES_DIR],
    `Update living OpenSpec specs for ${branch}`,
  );
}

function addRecoverableWarning(warnings: MergeWarning[], step: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  warnings.push({ step, message, recoverable: true });
  console.warn(`[workspace-merge] ${step} failed after git merge landed (recoverable):`, message);
}
