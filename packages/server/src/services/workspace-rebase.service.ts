import { LEADING_REPO_KEY, type RepoRebaseResponse } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import {
  resolveProjectId,
  resolveProjectRepo,
  getWorkspaceById,
} from "../repositories/workspace.repository.js";
import { markWorkspaceSummaryDirty } from "../repositories/workspace-summary-projection.repository.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { refreshWorkspaceBuildArtifacts } from "./workspace-build-refresh.service.js";
import { getAllWorkspaceRepos } from "./workspace-all-repos.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The REBASE half of the workspace-merge service (#802), extracted as a cohesive sub-module.
 *
 * `updateBase` / `abortRebase` / `rebaseRepo` never LAND anything — they only move a
 * workspace's branch (and every sibling worktree's branch) onto its base, or undo an
 * in-progress rebase. That is a different job from `mergeWorkspace`/`doMerge`, which own
 * the merge lock, the pre-merge gate and the post-merge cleanup, so the two split cleanly
 * along the seam the names already suggest. The three functions keep their bodies verbatim;
 * only the collaborators they used to close over are now explicit dependencies.
 *
 * `createWorkspaceMergeService` binds this factory and re-exports the three functions, so
 * every existing caller and route keeps its import path and behaviour.
 */
export function createWorkspaceRebaseService(deps: {
  database: Database;
  gitService: GitService;
  boardEvents?: BoardEventSink;
  /** Best-effort kill of processes in a worktree dir — shared with the merge half. */
  killWorktreeProcesses: (workingDir: string | null | undefined, label: string) => Promise<void>;
}) {
  const { database, gitService, boardEvents, killWorktreeProcesses } = deps;

  async function updateBase(id: string, mode: "rebase" | "merge") {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      throw new WorkspaceError("Not supported for direct workspaces", "BAD_REQUEST");
    }
    if (workspace.status === "closed") {
      throw new WorkspaceError("Workspace is closed", "BAD_REQUEST");
    }

    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    // Multi-repo (#72): a cross-cutting ticket touches every repo, so update-base must
    // rebase/merge the leading repo AND every sibling worktree — otherwise a trailing
    // cross-cutting ticket stays behind base in the siblings and strands on merge.

    // Refuse if main checkout HEAD has drifted off the target branch (consistent with /merge guard).
    const currentHeadBranch = await gitService.getCurrentBranch(repoPath);
    if (currentHeadBranch !== baseBranch) {
      throw new WorkspaceError(
        `Cannot update base: main checkout HEAD is on '${currentHeadBranch}' but this workspace targets '${baseBranch}'. ` +
          `Check out '${baseBranch}' in the main checkout before proceeding.`,
        "CONFLICT",
        { currentBranch: currentHeadBranch, targetBranch: baseBranch },
      );
    }

    const runUpdate = (worktree: string, branch: string | null, base: string) =>
      mode === "merge"
        ? gitService.mergeBaseIntoBranch(worktree, base)
        : gitService.rebaseOntoBase(worktree, base, branch ?? "", { preferLocalBase: true });

    // One loop over the uniform repo view (#168): rebase/merge the leading repo (row 0) AND every
    // sibling worktree onto its own base — replacing the old "leading line, then sibling loop".
    // Leading conflicts are reported bare and its errors PROPAGATE (unchanged); sibling conflicts
    // are namespaced by repo and a sibling error is caught so one unreachable repo doesn't abort the
    // others. A repo whose worktree/branch is gone (already landed/cleaned) is skipped. Overall
    // success requires every repo. Processes are killed around each history rewrite.
    const allRepos = await getAllWorkspaceRepos(id, database);
    // #275 — pinned so the artifact refresh below can tell a real rebase from a no-op.
    const headShaBefore = await gitService.revParse(workspace.workingDir, "HEAD").catch(() => null);
    let result: { success: boolean; conflictingFiles?: string[]; error?: string } = { success: true };
    for (const ref of allRepos) {
      const isLeading = ref.kind === "leading";
      const worktree = isLeading ? workspace.workingDir : ref.worktreePath;
      if (!worktree || !ref.branch) continue;
      const repoBase = isLeading ? baseBranch : requireBaseBranch(ref.baseBranch || baseBranch);
      const ns = isLeading ? null : (ref.name ?? ref.path);
      await killWorktreeProcesses(worktree, isLeading ? `update-base:pre` : `update-base:sibling-pre:${ns}`);
      let repoResult: { success: boolean; conflictingFiles?: string[]; error?: string };
      if (isLeading) {
        repoResult = await runUpdate(worktree, ref.branch, repoBase); // leading errors propagate (as before)
      } else {
        try {
          repoResult = await runUpdate(worktree, ref.branch, repoBase);
        } catch (err) {
          repoResult = { success: false, error: `${ns}: ${errorMessage(err)}` };
        }
      }
      await killWorktreeProcesses(worktree, isLeading ? `update-base:post` : `update-base:sibling-post:${ns}`);
      if (!repoResult.success) {
        // #928 — rebaseOntoBase leaves a genuine conflict IN PROGRESS (detached HEAD,
        // rebase-merge dir) for the caller to resolve. update-base has no resolution UI of
        // its own (that's /resolve-conflicts on a fix-and-merge session), so a conflict here
        // must abort immediately: the conflict list is already captured above, and leaving
        // the worktree detached mid-rebase strands it for relaunch/diff/merge/the monitor
        // until someone hand-runs `git rebase --abort` (repro: #905, same shape as #102).
        await gitService.abortRebase(worktree).catch(() => { /* best effort — nothing to abort */ });
        result = {
          success: false,
          conflictingFiles: [
            ...(result.conflictingFiles ?? []),
            ...(repoResult.conflictingFiles ?? []).map((f) => (ns ? `${ns}::${f}` : f)),
          ],
          error: [result.error, repoResult.error].filter(Boolean).join("; ") || result.error,
        };
      }
    }

    console.log(`[workspace-service] update-base: workspaceId=${id} mode=${mode} repos=${allRepos.length} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

    // #399 (decision 014): the rebase/merge rewrote this worktree's history, so the
    // persisted summary projection (head sha, commits-ahead count) is now wrong — mark
    // dirty so the next board read / heal tick refreshes it. Marked even on a failed
    // update: a partial sibling rebase may still have moved HEAD.
    await markWorkspaceSummaryDirty(id, database).catch(() => {});

    const projectId = await resolveProjectId(id, database);

    if (result.success) {
      // #275 — the rebase rewrote this worktree's SOURCE but nothing rebuilt its gitignored
      // generated output, so the next verify gate would type-check fresh src against months-old
      // artifacts and fail for reasons that have nothing to do with the branch. Repair it now,
      // while it is cheap, instead of paying a 20-40 minute gate run to discover it.
      await refreshWorkspaceBuildArtifacts({
        workingDir: workspace.workingDir,
        projectId,
        database,
        headShaBefore,
        headShaAfter: await gitService.revParse(workspace.workingDir, "HEAD").catch(() => null),
      });
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
    }

    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    return result;
  }

  async function abortRebase(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    // Idempotent: `git rebase --abort` exits non-zero when no rebase is in progress
    // (e.g. a stale UI retry, or a rebase that already resolved), which previously
    // surfaced as a 500. Only invoke it when a rebase is actually in progress.
    if (await gitService.isRebaseInProgress(workspace.workingDir)) {
      await gitService.abortRebase(workspace.workingDir);
    }
    await killWorktreeProcesses(workspace.workingDir, "abort-rebase");
    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");
    return { ok: true };
  }

  /**
   * Per-repo recovery for a stranded sibling (#93): rebase just ONE repo's worktree branch
   * onto its own base — the leading repo (`repoName === LEADING_REPO_KEY`) or a single sibling
   * addressed by name. This is REBASE ONLY: it never lands anything, so the all-or-nothing
   * coordinated-merge invariant (prevalidateSiblingMerges/executeSiblingMerges) is untouched —
   * landing is still the whole-workspace merge. On conflict the in-progress rebase is aborted
   * so the worktree is left clean (there is no per-sibling conflict-resolution flow), and the
   * conflicting files are reported so the strip can surface them. Spawns git only through the
   * sanctioned adapter via gitService.rebaseOntoBase/abortRebase.
   */
  async function rebaseRepo(id: string, repoName: string): Promise<RepoRebaseResponse> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      throw new WorkspaceError("Not supported for direct workspaces", "BAD_REQUEST");
    }
    if (workspace.status === "closed") {
      throw new WorkspaceError("Workspace is closed", "BAD_REQUEST");
    }

    // One uniform lookup (#168): the leading repo (addressed by the LEADING_REPO_KEY sentinel)
    // and the siblings come from the same list, so this no longer hand-assembles the leading
    // block separately from a sibling `.find`.
    const allRepos = await getAllWorkspaceRepos(id, database);
    const leadingRef = allRepos.find((r) => r.kind === "leading");
    const workspaceBase = requireBaseBranch(leadingRef?.baseBranch ?? workspace.baseBranch);

    let worktree: string;
    let branch: string;
    let base: string;
    let label: string;

    if (repoName === LEADING_REPO_KEY) {
      if (!workspace.branch) throw new WorkspaceError("Leading repo has no branch to rebase", "BAD_REQUEST");
      worktree = workspace.workingDir;
      branch = workspace.branch;
      base = workspaceBase;
      label = "leading";
    } else {
      const repo = allRepos.find((r) => r.kind === "sibling" && r.name === repoName);
      if (!repo) throw new WorkspaceError(`Repo '${repoName}' is not part of this workspace`, "NOT_FOUND");
      if (!repo.worktreePath || !repo.branch) {
        throw new WorkspaceError(`Repo '${repoName}' has no worktree to rebase`, "BAD_REQUEST");
      }
      worktree = repo.worktreePath;
      branch = repo.branch;
      base = requireBaseBranch(repo.baseBranch || workspaceBase);
      label = repoName;
    }

    // Stop leftover agent processes before rewriting history in the worktree.
    await killWorktreeProcesses(worktree, `rebase-repo:pre:${label}`);
    // preferLocalBase mirrors update-base: the board merges into the LOCAL base, so rebase onto
    // it (a stale origin would replay local-only history and conflict spuriously).
    const result = await gitService.rebaseOntoBase(worktree, base, branch, { preferLocalBase: true });
    if (!result.success) {
      // rebaseOntoBase leaves the conflicted rebase in progress; abort so the worktree is clean.
      await gitService.abortRebase(worktree).catch(() => { /* best effort — nothing to abort */ });
    }
    await killWorktreeProcesses(worktree, `rebase-repo:post:${label}`);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    console.log(`[workspace-merge] rebase-repo: workspaceId=${id} repo=${label} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);
    return { repo: label, success: result.success, conflictingFiles: result.conflictingFiles, error: result.error };
  }

  return { updateBase, abortRebase, rebaseRepo };
}
