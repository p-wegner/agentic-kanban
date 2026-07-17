import type { Database } from "../db/index.js";
import { resolveProjectRepo, getWorkspaceById } from "../repositories/workspace.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";

/** Per-repo merge status for one repo of a multi-repo workspace (#70). */
export interface RepoMergeStatusEntry {
  name: string | null;
  path: string;
  isLeading: boolean;
  /** The repo's branch ever diverged from base (or a sibling merge was stamped). */
  hasWork: boolean;
  /** Commits on the branch not yet on base (0 once landed). */
  ahead: number;
  /** The work has landed on base. */
  merged: boolean;
  /** Has work, but it is NOT on base — the #69 failure mode, made visible. */
  stranded: boolean;
}

export interface RepoMergeStatus {
  branch: string | null;
  baseBranch: string;
  allMerged: boolean;
  repos: RepoMergeStatusEntry[];
}

/**
 * Per-repo merge status for a multi-repo workspace (#70): for the leading repo and every
 * sibling, report whether it has work and whether that work has landed on base — so a
 * partial multi-repo merge (or a sibling-only ticket) is VISIBLE instead of hiding behind
 * the workspace's single scalar `mergedAt`. Extracted from workspace-merge.service.ts to
 * keep that module under the god-module ceiling.
 */
export async function getRepoMergeStatus(
  id: string,
  deps: { database: Database; gitService: GitService },
): Promise<RepoMergeStatus> {
  const { database, gitService } = deps;
  const workspace = await getWorkspaceById(id, database);
  if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
  if (workspace.isDirect) throw new WorkspaceError("Not applicable to direct workspaces", "BAD_REQUEST");
  const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
  const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

  const repos: RepoMergeStatusEntry[] = [];

  // Leading repo. "had work" = ahead now, or the branch diverged from its original base cut.
  let leadingAhead = 0;
  if (workspace.branch) {
    leadingAhead = await gitService.countUniqueCommits(repoPath, baseBranch, workspace.branch).catch(() => 0);
  }
  const leadingHistoric = leadingAhead === 0 && workspace.branch && workspace.baseCommitSha
    ? await gitService.countUniqueCommits(repoPath, workspace.baseCommitSha, workspace.branch).catch(() => 0)
    : 0;
  const leadingHasWork = leadingAhead > 0 || leadingHistoric > 0 || Boolean(workspace.mergedAt);
  repos.push({
    name: null,
    path: repoPath,
    isLeading: true,
    hasWork: leadingHasWork,
    ahead: leadingAhead,
    merged: leadingHasWork && leadingAhead === 0,
    stranded: leadingHasWork && leadingAhead > 0,
  });

  // Sibling repos.
  for (const repo of await listWorkspaceRepos(id, database)) {
    if (repo.mergedHeadSha) {
      repos.push({ name: repo.name, path: repo.path, isLeading: false, hasWork: true, ahead: 0, merged: true, stranded: false });
      continue;
    }
    let ahead = 0;
    let resolvable = true;
    if (repo.branch && repo.baseBranch) {
      try {
        await gitService.revParse(repo.path, repo.baseBranch);
        await gitService.revParse(repo.path, repo.branch);
        ahead = await gitService.countUniqueCommits(repo.path, repo.baseBranch, repo.branch).catch(() => 0);
      } catch { resolvable = false; }
    }
    const hasWork = ahead > 0;
    repos.push({
      name: repo.name,
      path: repo.path,
      isLeading: false,
      hasWork,
      ahead,
      // branch ref gone + not stamped = cleaned up after landing → treat as merged.
      merged: !hasWork && !resolvable,
      stranded: hasWork,
    });
  }

  const allMerged = repos.every((r) => !r.hasWork || r.merged);
  return { branch: workspace.branch, baseBranch, allMerged, repos };
}
