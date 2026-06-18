import { getProjectById } from "../repositories/project.repository.js";
import {
  getIssueProjectRef,
  getWorkspacesForIssueMergedCommits,
} from "../repositories/issue-merged-commits.repository.js";
import type { MergedCommit, MergedCommitsResponse } from "@agentic-kanban/shared";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as realGitService from "./git.service.js";
import type { GitService } from "./workspace-internals.js";

/**
 * Resolve the commits that landed on the project's default branch for an issue.
 *
 * For each of the issue's MERGED workspaces (those with a `mergedAt` timestamp),
 * lists the commits the workspace branch contributed relative to the commit it
 * was cut from (`baseCommitSha`), using a read-only `git log`. Falls back to the
 * default branch as the base when no recorded base commit exists. Results are
 * flattened across workspaces, de-duplicated by SHA, and sorted newest-first.
 *
 * Returns `merged: false` with an empty commit list when the issue has no merged
 * workspace yet (drives the empty state on the issue detail view).
 */
export function createIssueMergedCommitsService(deps: {
  database?: Database;
  gitService?: GitService;
}) {
  const database = deps.database ?? db;
  const gitService = deps.gitService ?? realGitService;

  async function getMergedCommits(issueId: string): Promise<MergedCommitsResponse | null> {
    const issueRow = await getIssueProjectRef(issueId, database);
    if (!issueRow) return null;

    const project = await getProjectById(issueRow.projectId, database);
    if (!project) return null;

    const { repoPath, defaultBranch } = project;

    const wsRows = await getWorkspacesForIssueMergedCommits(issueId, database);

    // Only merged, non-direct workspaces have a branch whose commits landed on the
    // default branch. Direct workspaces commit straight onto the working branch and
    // carry no separate feature branch to diff.
    const mergedWorkspaces = wsRows.filter((w) => w.mergedAt && !w.isDirect && w.branch);

    if (mergedWorkspaces.length === 0) {
      return { merged: false, defaultBranch, commits: [] };
    }

    const seen = new Set<string>();
    const commits: MergedCommit[] = [];
    for (const ws of mergedWorkspaces) {
      const baseRef = ws.baseCommitSha || ws.baseBranch || defaultBranch;
      if (!baseRef) continue;
      // Post-merge cleanup deletes the feature branch, so `ws.branch` usually no
      // longer resolves as a ref. Prefer the branch-tip SHA captured at merge time
      // (it stays reachable from the default branch); fall back to the branch name
      // for not-yet-cleaned-up or older merges that predate `mergedHeadSha`.
      const tipRef = ws.mergedHeadSha || ws.branch;
      const branchCommits = await gitService.getCommitsForBranch(repoPath, baseRef, tipRef);
      for (const c of branchCommits) {
        if (seen.has(c.sha)) continue;
        seen.add(c.sha);
        commits.push({ ...c, branch: ws.branch, workspaceId: ws.id });
      }
    }

    commits.sort((a, b) => b.date.localeCompare(a.date));

    return { merged: true, defaultBranch, commits };
  }

  return { getMergedCommits };
}
