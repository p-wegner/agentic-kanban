import type { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionLauncher } from "./session.manager.js";
import type { BoardEventSink } from "./board-events.js";
import {
  resolveProjectId,
  resolveProjectRepo,
  getWorkspaceById,
  updateWorkspaceStatus,
} from "../repositories/workspace.repository.js";
import {
  getConflictingFiles,
  buildConflictResolutionPrompt,
} from "./merge-helpers.service.js";
import { buildConflictContext } from "./phase-context.service.js";
import { toExecutorProvider } from "./agent-settings.service.js";
import {
  WorkspaceError,
  resolveRelaunchAgentSelection,
  requireBaseBranch,
  type GitService,
} from "./workspace-internals.js";

/**
 * #1209: `resolveConflicts` extracted out of `createWorkspaceMergeService` (kept the factory
 * under the shrink-only nloc ratchet, `function-nloc-ratchet.test.ts`) — same shape as #802's
 * extraction of the rebase family. Deps are explicit rather than closed over, so this module has
 * no hidden coupling to the merge service's other locals.
 *
 * Before this fix, resolve-conflicts spawned the agent straight into whatever the worktree
 * already was — HEAD on the member's own branch, no rebase or merge in progress. The conflict
 * this endpoint exists to fix only exists RELATIVE TO the base branch, so an agent dropped into
 * that worktree truthfully finds a clean tree and reports "nothing to resolve" (observed live on
 * #1199/#1186: two sessions exited 0 in 8-14s having done nothing, and the branches still
 * conflicted with master afterwards).
 *
 * The fix mirrors the fix-and-merge preflight (`rebaseOneWorktreeForFixAndMerge` in
 * `workspace-merge.service.ts`): rebase the worktree onto its base FIRST.
 * `gitService.rebaseOntoBase` leaves a genuine conflict IN PROGRESS (detached HEAD, `UU` files)
 * rather than aborting it — unlike fix-and-merge, which deliberately aborts and asks for a
 * `git merge` instead, because a fix-and-merge agent might also need to fix a RED gate and a
 * detached rebase would block that. resolve-conflicts has exactly one job (resolve a conflict),
 * so leaving the rebase in progress and asking for `git rebase --continue` is the direct,
 * unambiguous instruction — and it is also the state that makes `getConflictingFiles`'s
 * `git diff --diff-filter=U` actually return something.
 *
 * If the rebase completes cleanly, there is nothing for an agent to do: mark the workspace ready
 * again and report `resolved: "rebase-clean"` without spawning a session.
 */
export interface ResolveConflictsDeps {
  database: Database;
  gitService: GitService;
  getSessionManager?: () => SessionLauncher;
  boardEvents?: BoardEventSink;
  killWorktreeProcesses: (workingDir: string | null | undefined, label: string) => Promise<void>;
  recoverZeroOutputRunningFixAndMergeSession: (workspace: typeof workspaces.$inferSelect) => Promise<void>;
  recoverFailedFixAndMergeSessionIfNeeded: (workspace: typeof workspaces.$inferSelect) => Promise<void>;
  recordMergeAttempt: (
    workspace: typeof workspaces.$inferSelect,
    eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed" | "gate-failed",
    body: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

export function createWorkspaceResolveConflictsService(deps: ResolveConflictsDeps) {
  const { database, gitService, getSessionManager, boardEvents, killWorktreeProcesses, recordMergeAttempt } = deps;

  async function resolveConflicts(id: string): Promise<{ sessionId: string } | { resolved: "rebase-clean" }> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    await deps.recoverZeroOutputRunningFixAndMergeSession(workspace);
    await deps.recoverFailedFixAndMergeSessionIfNeeded(workspace);
    const refreshedWorkspace = await getWorkspaceById(id, database);
    if (!refreshedWorkspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!refreshedWorkspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    if (refreshedWorkspace.status === "fixing") throw new WorkspaceError("Conflict resolution already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    // Kill leftover worktree processes before rebasing / spawning the resolution agent.
    await killWorktreeProcesses(refreshedWorkspace.workingDir, "resolve-conflicts");

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(refreshedWorkspace.baseBranch || defaultBranch);

    // Put the worktree INTO the conflicted state relative to base — nothing else does this.
    const rebaseResult = await gitService.rebaseOntoBase(
      refreshedWorkspace.workingDir,
      baseBranch,
      refreshedWorkspace.branch ?? "",
      { preferLocalBase: true },
    );

    if (rebaseResult.success) {
      // The rebase itself resolved it — no conflict remains, so no agent is needed.
      await updateWorkspaceStatus(id, "idle", { readyForMerge: true }, database);
      const cleanProjectId = await resolveProjectId(id, database);
      if (cleanProjectId) boardEvents?.broadcast(cleanProjectId, "board_changed");
      console.log(`[workspace-merge] resolve-conflicts: workspaceId=${id} rebase onto '${baseBranch}' completed cleanly — nothing to resolve`);
      return { resolved: "rebase-clean" as const };
    }

    // Rebase conflicted: LEFT IN PROGRESS (unlike fix-and-merge, which aborts) so the agent
    // resolves the real conflicted state instead of a fabricated one, and so getConflictingFiles
    // (git diff --diff-filter=U) actually finds the unmerged files below.
    const conflictingFiles = rebaseResult.conflictingFiles?.length
      ? rebaseResult.conflictingFiles
      : await getConflictingFiles(refreshedWorkspace.workingDir);
    const conflictContext = await buildConflictContext(refreshedWorkspace.workingDir, conflictingFiles);
    const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch, conflictContext);

    const resolverProjectId = await resolveProjectId(id, database);
    const { agentCommand, agentArgs, profile, provider, model } =
      await resolveRelaunchAgentSelection(database, resolverProjectId, refreshedWorkspace);
    const executorProvider = toExecutorProvider(provider);

    // #1209: pinned so the exit handler can tell a real fix from a no-op — a session that
    // exits having never moved the branch tip off the mid-rebase HEAD it was launched into.
    const headShaBeforeSession = await gitService.revParse(refreshedWorkspace.workingDir, "HEAD").catch(() => null);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, profile, model,
      provider: executorProvider, multiTurn: executorProvider === "codex" ? false : true, triggerType: "fix-conflicts",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);
    // #1209: record the pre-session HEAD so a no-op session (branch tip unchanged, still
    // conflicting) can be detected at exit instead of read as a completed fix.
    await recordMergeAttempt(
      refreshedWorkspace,
      "fix-and-merge-launched",
      `Launched a resolve-conflicts session for workspace ${id} (rebase onto '${baseBranch}' left in progress).`,
      { sessionId, targetBranch: baseBranch, conflictingFiles, headShaBeforeSession },
    );

    if (resolverProjectId) boardEvents?.broadcast(resolverProjectId, "session_launched");

    return { sessionId };
  }

  return { resolveConflicts };
}
