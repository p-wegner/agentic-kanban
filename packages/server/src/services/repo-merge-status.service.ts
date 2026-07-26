import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";
import { getAllWorkspaceRepos, type WorkspaceRepoRef } from "./workspace-all-repos.js";

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

  // One loop over the uniform repo view (#168): the leading repo (row 0) and each sibling run the
  // SAME per-repo status computation, replacing the old hand-written leading block + sibling loop
  // that drifted. `requireBaseBranch` still validates that the leading has a resolvable base.
  const allRepos = await getAllWorkspaceRepos(id, database);
  const leadingRef = allRepos.find((r) => r.kind === "leading");
  const baseBranch = requireBaseBranch(leadingRef?.baseBranch ?? workspace.baseBranch);

  const repos: RepoMergeStatusEntry[] = [];
  for (const ref of allRepos) {
    repos.push(await computeRepoMergeEntry(ref, gitService));
  }

  const allMerged = repos.every((r) => !r.hasWork || r.merged);
  return { branch: workspace.branch, baseBranch, allMerged, repos };
}

/**
 * Per-repo merge status, identical for the leading repo and every sibling (#168 collapses the
 * two divergent code paths). "had work" = commits ahead of base now, OR — once merged and the
 * feature branch is cleaned up — commits between the original cut point and the captured merge tip.
 *
 * - A stamped `mergedHeadSha` is positive merge evidence (only ever set for genuinely-landed work
 *   by executeSiblingMerges / the clean auto-merge / the reconcile stamp), so it short-circuits to
 *   `merged`. This is what the sibling path always did; the leading path reaches the same verdict
 *   via its historic-tip computation, so unifying on the short-circuit changes no tested/real case.
 * - Otherwise: `ahead` = commits vs the base BRANCH (guarded revParse; gone refs → 0). When 0-ahead,
 *   `historic` counts vs the original cut commit using the live branch tip, else the stamped tip.
 * - Deliberately NOT keyed off the workspace scalar `mergedAt` (stamped even for a sibling-only
 *   merge, #74/#75): for a sibling-only merge the leading's captured tip equals base → 0 historic →
 *   leading correctly reads no-work.
 */
async function computeRepoMergeEntry(ref: WorkspaceRepoRef, gitService: GitService): Promise<RepoMergeStatusEntry> {
  const base = { name: ref.kind === "leading" ? null : ref.name, path: ref.path, isLeading: ref.kind === "leading" };
  if (ref.mergedHeadSha) {
    return { ...base, hasWork: true, ahead: 0, merged: true, stranded: false };
  }
  let ahead = 0;
  if (ref.branch && ref.baseBranch) {
    try {
      await gitService.revParse(ref.path, ref.baseBranch);
      await gitService.revParse(ref.path, ref.branch);
      ahead = await gitService.countUniqueCommits(ref.path, ref.baseBranch, ref.branch).catch(() => 0);
    } catch { /* branch/base ref gone (e.g. cleaned up) → no countable work */ }
  }
  let historic = 0;
  if (ahead === 0 && ref.baseCommitSha) {
    let tip: string | null = null;
    if (ref.branch && (await gitService.revParse(ref.path, ref.branch).then(() => true).catch(() => false))) {
      tip = ref.branch;
    } else if (ref.mergedHeadSha) {
      tip = ref.mergedHeadSha;
    }
    if (tip) historic = await gitService.countUniqueCommits(ref.path, ref.baseCommitSha, tip).catch(() => 0);
  }
  const hasWork = ahead > 0 || historic > 0;
  return { ...base, hasWork, ahead, merged: hasWork && ahead === 0, stranded: hasWork && ahead > 0 };
}
