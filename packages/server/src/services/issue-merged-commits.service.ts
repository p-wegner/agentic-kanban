import { eq } from "drizzle-orm";
import { issues, projects, workspaces } from "@agentic-kanban/shared/schema";
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
    const issueRows = await database
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (issueRows.length === 0) return null;

    const projectRows = await database
      .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, issueRows[0].projectId))
      .limit(1);
    if (projectRows.length === 0) return null;

    const { repoPath, defaultBranch } = projectRows[0];

    const wsRows = await database
      .select({
        id: workspaces.id,
        branch: workspaces.branch,
        baseBranch: workspaces.baseBranch,
        baseCommitSha: workspaces.baseCommitSha,
        mergedAt: workspaces.mergedAt,
        isDirect: workspaces.isDirect,
      })
      .from(workspaces)
      .where(eq(workspaces.issueId, issueId));

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
      const branchCommits = await gitService.getCommitsForBranch(repoPath, baseRef, ws.branch);
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
