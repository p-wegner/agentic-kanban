import type { Database } from "../db/index.js";
import type { DiffStatsResponse, DiffStatsRepoEntry, WorkspaceHandoffResponse, WorkspaceHandoffRepoEntry } from "@agentic-kanban/shared";
import * as realGitService from "./git.service.js";
import { getWorkspaceById, resolveProjectRepo } from "../repositories/workspace.repository.js";
import { getDiffComments } from "../repositories/session.repository.js";
import { parseDiffStats } from "./board-aggregation.service.js";
import { WorkspaceError, requireBaseBranch, type GitService } from "./workspace-internals.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import { readHandoffMeta, type HandoffMeta } from "./handoff.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** Freshness window for serving `?stats=1` from the persisted diff_stat_cache columns —
 * the same 30s SWR cadence that maintains them (workspace-diff-stats / the #399 chain). */
const DIFF_STAT_CACHE_TTL_MS = 30_000;

export function createWorkspaceDiffService(deps: {
  database: Database;
  gitService?: GitService;
}) {
  const { database } = deps;
  const gitService = deps.gitService ?? realGitService;

  async function getWorkspaceDiff(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir && !workspace.branch) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    let diff = "";
    let conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    if (workspace.isDirect) {
      diff = workspace.workingDir
        ? await gitService.getWorkingTreeDiff(workspace.workingDir)
        : "";
    } else {
      let usedWorktree = false;
      if (workspace.workingDir) {
        try {
          diff = await gitService.getDiff(workspace.workingDir, baseBranch);
          conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
          usedWorktree = true;
        } catch {
          // Worktree directory exists but is not a valid git repo — fall through
        }
      }
      if (!usedWorktree) {
        if (workspace.branch) {
          diff = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
        } else {
          diff = "";
        }
      }
    }

    // Multi-repo (full-peers): append each sibling repo's diff so review sees the
    // combined change set. Single-repo workspaces have no rows here — the response
    // stays exactly as before (no `repos` field). Sibling diff failures are
    // non-fatal: the leading diff still renders, the section reports the error.
    let repoSections: Array<{
      name: string | null;
      path: string;
      diff: string;
      stats: { filesChanged: number; insertions: number; deletions: number };
      conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
    }> | undefined;
    if (!workspace.isDirect) {
      const siblingRepos = await listWorkspaceRepos(id, database);
      if (siblingRepos.length > 0) {
        repoSections = [{ name: null, path: repoPath, diff, stats: parseDiffStats(diff), conflicts }];
        for (const repo of siblingRepos) {
          let repoDiff = "";
          let repoConflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null = null;
          try {
            if (repo.worktreePath) {
              repoDiff = await gitService.getDiff(repo.worktreePath, repo.baseBranch ?? baseBranch);
              repoConflicts = await gitService.detectConflicts(repo.worktreePath, repo.baseBranch ?? baseBranch);
            } else if (repo.branch) {
              repoDiff = await gitService.getDiffFromRepo(repo.path, repo.branch, repo.baseBranch ?? baseBranch);
            }
          } catch (err) {
            console.warn(`[workspace-service] sibling diff failed for ${repo.path} (non-fatal): ${errorMessage(err)}`);
          }
          repoSections.push({ name: repo.name, path: repo.path, diff: repoDiff, stats: parseDiffStats(repoDiff), conflicts: repoConflicts });
          if (repoDiff) diff += (diff && !diff.endsWith("\n") ? "\n" : "") + repoDiff;
          if (repoConflicts?.hasConflicts) {
            conflicts = {
              hasConflicts: true,
              conflictingFiles: [...(conflicts?.conflictingFiles ?? []), ...repoConflicts.conflictingFiles],
            };
          }
        }
      }
    }

    const stats = parseDiffStats(diff);
    const comments = await getDiffComments(id, undefined, database);
    console.log(`[workspace-service] diff: workspaceId=${id} isDirect=${workspace.isDirect} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions} conflicts=${conflicts?.hasConflicts ?? "n/a"} comments=${comments.length}`);
    return repoSections ? { diff, stats, comments, conflicts, repos: repoSections } : { diff, stats, comments, conflicts };
  }

  /**
   * #415 — the `?stats=1` diff variant: per-repo shortstat numbers only, no diff bodies.
   * One `git diff --shortstat` per repo (M spawns) instead of the full diff + conflict
   * probe + untracked-content inlining (3M spawns) the heatmap used to pay to read three
   * integers. The leading repo is served from the persisted `diff_stat_cache_*` columns
   * when their stamp is fresh (the same 30s SWR cadence the summary projection chains),
   * dropping to M-1 spawns on a warm row.
   */
  async function getWorkspaceDiffStats(id: string): Promise<DiffStatsResponse> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir && !workspace.branch) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = workspace.isDirect ? "HEAD" : requireBaseBranch(workspace.baseBranch || defaultBranch);

    const zero = { filesChanged: 0, insertions: 0, deletions: 0 };
    const cacheFresh =
      workspace.diffStatCacheCheckedAt !== null &&
      Date.now() - new Date(workspace.diffStatCacheCheckedAt).getTime() < DIFF_STAT_CACHE_TTL_MS;
    let leadingStats: { filesChanged: number; insertions: number; deletions: number };
    if (cacheFresh) {
      leadingStats = {
        filesChanged: workspace.diffStatCacheFilesChanged ?? 0,
        insertions: workspace.diffStatCacheInsertions ?? 0,
        deletions: workspace.diffStatCacheDeletions ?? 0,
      };
    } else if (workspace.workingDir) {
      leadingStats = await gitService.getDiffShortstat(workspace.workingDir, baseBranch).catch(() => zero);
    } else {
      leadingStats = zero;
    }

    const repoEntries: DiffStatsRepoEntry[] = [{ name: null, path: repoPath, stats: leadingStats }];
    if (!workspace.isDirect) {
      for (const repo of await listWorkspaceRepos(id, database)) {
        let stats = zero;
        if (repo.worktreePath) {
          stats = await gitService.getDiffShortstat(repo.worktreePath, repo.baseBranch ?? baseBranch).catch(() => zero);
        }
        repoEntries.push({ name: repo.name, path: repo.path, stats });
      }
    }

    const total = repoEntries.reduce(
      (acc, r) => ({
        filesChanged: acc.filesChanged + r.stats.filesChanged,
        insertions: acc.insertions + r.stats.insertions,
        deletions: acc.deletions + r.stats.deletions,
      }),
      { ...zero },
    );
    return { stats: total, repos: repoEntries };
  }

  async function getConflicts(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      return { hasConflicts: false, conflictingFiles: [] };
    }

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const result = await gitService.detectConflicts(workspace.workingDir, baseBranch);

    // Multi-repo: a conflict in ANY sibling repo blocks the same way (no-op single-repo).
    const siblingRepos = await listWorkspaceRepos(id, database);
    let hasConflicts = result.hasConflicts;
    const conflictingFiles = [...result.conflictingFiles];
    for (const repo of siblingRepos) {
      if (!repo.worktreePath || !repo.baseBranch) continue;
      try {
        const repoResult = await gitService.detectConflicts(repo.worktreePath, repo.baseBranch);
        if (repoResult.hasConflicts) {
          hasConflicts = true;
          conflictingFiles.push(...repoResult.conflictingFiles);
        }
      } catch (err) {
        console.warn(`[workspace-service] sibling conflict check failed for ${repo.path} (non-fatal): ${errorMessage(err)}`);
      }
    }
    return { hasConflicts, conflictingFiles };
  }

  async function getLatestCommit(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) return { sha: null, message: null };
    const commit = await gitService.getLatestCommit(workspace.workingDir);
    return commit ?? { sha: null, message: null };
  }

  /**
   * HANDOFF.md metadata for the cross-repo activity feed (#89). Read-only: reports the
   * leading repo's HANDOFF.md (which #78 already folds sibling diffs into) plus a per-repo
   * `repos` array covering the leading worktree and every sibling worktree — so a sibling
   * that carries its own HANDOFF.md is surfaced too. Absent files/worktrees resolve to the
   * "no handoff" shape rather than erroring.
   */
  async function getHandoff(id: string): Promise<WorkspaceHandoffResponse> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const absent: HandoffMeta = { exists: false, updatedAt: null, excerpt: null };
    const repos: WorkspaceHandoffRepoEntry[] = [];

    const leading = workspace.workingDir ? await readHandoffMeta(workspace.workingDir) : absent;
    repos.push({ name: null, ...leading });

    if (!workspace.isDirect) {
      for (const repo of await listWorkspaceRepos(id, database)) {
        const meta = repo.worktreePath ? await readHandoffMeta(repo.worktreePath) : absent;
        repos.push({ name: repo.name, ...meta });
      }
    }

    return { exists: leading.exists, updatedAt: leading.updatedAt, excerpt: leading.excerpt, repos };
  }

  return { getWorkspaceDiff, getWorkspaceDiffStats, getConflicts, getLatestCommit, getHandoff };
}
