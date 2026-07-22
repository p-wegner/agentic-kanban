import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { resolveProjectRepo, getWorkspaceById } from "../repositories/workspace.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";

// The wire contract lives in @agentic-kanban/shared (types/api/workspace.ts) so the
// client consumes the same shape (#79); these aliases keep existing importers working.
export type RepoMergeStatusEntry = RepoMergeStatusRepoEntry;
export type RepoMergeStatus = RepoMergeStatusResponse;

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

  // Leading repo. "had work" = commits ahead of base now, OR (once merged and the feature
  // branch is cleaned up) commits between the original base cut and the captured merge tip.
  // The historic tip is the branch ref while it still exists, else `mergedHeadSha`, which is
  // stamped at merge time and survives the post-merge branch deletion. Deliberately NOT keyed
  // off the workspace scalar `mergedAt`: it is stamped even for a sibling-only merge (via
  // closeWorkspace markMerged, #74), and ORing it in falsely attributed the merge to the
  // LEADING repo when the leading repo had zero commits (#75). For a sibling-only merge the
  // captured tip equals base → 0 historic commits → leading correctly reads as no-work.
  let leadingAhead = 0;
  if (workspace.branch) {
    leadingAhead = await gitService.countUniqueCommits(repoPath, baseBranch, workspace.branch).catch(() => 0);
  }
  let leadingHistoric = 0;
  if (leadingAhead === 0 && workspace.baseCommitSha) {
    let tip: string | null = null;
    if (workspace.branch && (await gitService.revParse(repoPath, workspace.branch).then(() => true).catch(() => false))) {
      tip = workspace.branch;
    } else if (workspace.mergedHeadSha) {
      tip = workspace.mergedHeadSha;
    }
    if (tip) leadingHistoric = await gitService.countUniqueCommits(repoPath, workspace.baseCommitSha, tip).catch(() => 0);
  }
  const leadingHasWork = leadingAhead > 0 || leadingHistoric > 0;
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
    if (repo.branch && repo.baseBranch) {
      try {
        await gitService.revParse(repo.path, repo.baseBranch);
        await gitService.revParse(repo.path, repo.branch);
        ahead = await gitService.countUniqueCommits(repo.path, repo.baseBranch, repo.branch).catch(() => 0);
      } catch { /* branch/base ref gone (e.g. cleaned up) → no countable work */ }
    }
    const hasWork = ahead > 0;
    repos.push({
      name: repo.name,
      path: repo.path,
      isLeading: false,
      hasWork,
      ahead,
      // A sibling is "merged" only on positive evidence — a stamped `mergedHeadSha`, handled
      // above. A gone branch with no stamp is the no-work sibling (cleanup force-deletes EVERY
      // sibling branch, worked or not — #75), not a silent landing, so it is "no changes", not
      // merged. Every real sibling merge stamps mergedHeadSha (executeSiblingMerges /
      // reconcile), so this path never hides genuinely-landed work.
      merged: false,
      stranded: hasWork,
    });
  }

  const allMerged = repos.every((r) => !r.hasWork || r.merged);
  return { branch: workspace.branch, baseBranch, allMerged, repos };
}
