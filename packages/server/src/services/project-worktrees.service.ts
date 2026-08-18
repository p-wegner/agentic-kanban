/**
 * The project's git-WORKTREE surface: what `GET /api/projects/:id/worktrees` reports and what
 * `DELETE` reclaims.
 *
 * Split out of project.service.ts when #631 (spanning sibling repos) pushed that file past the
 * 1000-line god-module ceiling. The seam is a real one rather than a size-driven cut: every
 * function here is about git worktrees on disk and their claim by a board workspace, and none
 * of the rest of project.service — board reads, stats, archiving, registration — touches that
 * subject. `database` is the only thing it needed from the enclosing closure.
 */

import { sep } from "node:path";
import { getProjectById } from "../repositories/project.repository.js";
import { listProjectRepos, getWorkspaceRepoClaims } from "../repositories/repo.repository.js";
import { getProjectWorkspacesWithIssue, getWorkspaceWorkingDirById } from "../repositories/project-service.repository.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import { listWorktrees, removeWorktree, getDiffShortstat } from "./git.service.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./workspace-services.service.js";
import { reapWorkspaceContainer } from "./devcontainer-workspace.service.js";
import { selectCachedDiffStats } from "../lib/workspace-diff-cache.js";
import { cachedWorktreeDiffStats, scheduleWorktreeDiffStatsRefresh, type DiffStats } from "../lib/worktree-diff-stats.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { ProjectError } from "./project-error.js";
import type { Database } from "../db/index.js";

export function createProjectWorktreesService(database: Database) {

  async function getWorktrees(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    const { repoPath, defaultBranch } = project;

    const gitWorktrees = await listWorktrees(repoPath);

    const projectWorkspaces = await getProjectWorkspacesWithIssue(projectId, database);

    // #631: this endpoint listed the LEADING repo only, so on a 17-repo project the panel
    // reported on 1 of 17 — it showed "Worktrees (1) — No additional worktrees" while 104
    // orphaned sibling worktrees existed across 13 repos. The panel that exists to surface
    // exactly this debris was structurally unable to see it. Siblings are appended below,
    // each tagged with its repo, and one that no `repos` row claims is reported as having
    // NO BOARD WORKSPACE — the orphan report the board previously had no way to produce.
    const siblingRepos = await listProjectRepos(projectId, database).catch(() => []);
    const siblingClaims = siblingRepos.length > 0
      ? await getWorkspaceRepoClaims(projectId, database).catch(() => [])
      : [];
    const claimByPath = new Map(
      siblingClaims
        .filter((c) => c.worktreePath)
        .map((c) => [c.worktreePath!.replace(/\//g, sep).toLowerCase(), c] as const),
    );

    const wsByDir = new Map<string, typeof projectWorkspaces[number]>();
    for (const ws of projectWorkspaces) {
      if (ws.workingDir) {
        wsByDir.set(ws.workingDir.replace(/\//g, sep), ws);
      }
    }

    // Synchronous per-worktree mapping: with the inline git spawns gone there is
    // nothing left to await, which is also why no per-request wall-clock budget is
    // needed here (see #342 note below) — the request is now one git spawn
    // (listWorktrees) plus one DB query, both already bounded.
    const leadingEntries = gitWorktrees.map((wt, index) => {
      const isMain = index === 0;
      const normalizedWtPath = wt.path.replace(/\//g, sep);

      let ws = wsByDir.get(normalizedWtPath);
      if (!ws && isMain) {
        for (const [, candidate] of wsByDir) {
          if (candidate.isDirect && candidate.workingDir && candidate.workingDir.startsWith(normalizedWtPath)) {
            ws = candidate;
            break;
          }
        }
      }

      // Diff stats are NEVER computed inline here (#342). This used to await one
      // `git diff --shortstat` subprocess per non-main worktree inside a Promise.all:
      // with ~45 active worktrees, 40+ parallel git spawns against one repo serialize
      // on Windows disk/index-lock contention and the endpoint measured 112.7s
      // followed by two 120s timeouts.
      //
      // A worktree that maps to a workspace is served from the diff_stat_cache_*
      // columns the board summary path already maintains. The rest are served from a
      // last-known-good in-process cache refreshed by a bounded background queue, so a
      // first sighting returns undefined — which the UI already renders the same as a
      // zero diff.
      let diffStats: DiffStats | undefined;
      if (!isMain) {
        const base = ws?.baseBranch || defaultBranch;
        if (base) {
          diffStats = ws
            ? (selectCachedDiffStats(ws) ?? undefined)
            : cachedWorktreeDiffStats(wt.path, base);
          if (!ws) {
            scheduleWorktreeDiffStatsRefresh(wt.path, base, () => getDiffShortstat(wt.path, base));
          }
        }
      }

      return {
        path: wt.path,
        branch: isMain ? (defaultBranch ?? (wt.branch.replace(/^refs\/heads\//, "") || "(unset)")) : wt.branch.replace(/^refs\/heads\//, ""),
        isMain,
        workspace: ws ? {
          id: ws.id,
          status: ws.status,
          isDirect: ws.isDirect,
          issueId: ws.issueId,
          issueNumber: ws.issueNumber,
          issueTitle: ws.issueTitle,
        } : undefined,
        diffStats,
      };
    });

    // Sibling worktrees, grouped after the leading repo's. Deliberately NOT interleaved:
    // the leading repo's entries carry diff stats and workspace links that the sibling rows
    // cannot, and a flat merged list would imply a parity that does not exist.
    const siblingEntries = (
      await Promise.all(
        siblingRepos.map(async (repo) => {
          const repoName = repo.name ?? repo.path.split(/[/\\]/).filter(Boolean).pop() ?? repo.path;
          let wts: { path: string; branch: string }[];
          try {
            wts = await listWorktrees(repo.path);
          } catch {
            return []; // an unreadable sibling must not fail the whole panel
          }
          return wts.slice(1).map((wt) => {
            const claim = claimByPath.get(wt.path.replace(/\//g, sep).toLowerCase());
            return {
              path: wt.path,
              branch: wt.branch.replace(/^refs\/heads\//, ""),
              isMain: false,
              repoName,
              // The orphan report: a sibling worktree that no `repos` row claims came from a
              // create that never persisted (#630), and nothing else in the UI can say so.
              orphaned: !claim,
              workspace: claim
                ? {
                    id: claim.workspaceId,
                    status: claim.status,
                    isDirect: false,
                    issueId: claim.issueId,
                    issueNumber: claim.issueNumber,
                    issueTitle: claim.issueTitle,
                  }
                : undefined,
            };
          });
        }),
      )
    ).flat();

    return [...leadingEntries, ...siblingEntries];
  }

  async function removeWorktreeById(projectId: string, body: { path?: string; workspaceId?: string }) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

    let removedPath = body.path;

    if (body.workspaceId) {
      const wsRows = await getWorkspaceWorkingDirById(body.workspaceId, database);

      if (wsRows.length === 0) {
        throw new ProjectError("Workspace not found", "NOT_FOUND");
      }

      const ws = wsRows[0];
      if (ws.workingDir) removedPath = ws.workingDir;

      // Per-workspace Docker service stack teardown runs UNCONDITIONALLY, before the
      // cascade delete, mirroring deleteWorkspace (workspace-crud.service.ts) — a
      // fork-child worktree removal must not strand its compose stack until the
      // startup reaper. Uses the STORED compose project name; the engine's
      // last-reference guard still skips the down while another live workspace
      // shares the same compose project. Best-effort — never throws.
      if (ws.workingDir && !ws.isDirect) {
        const composeName = parseStoredComposeProjectName(ws.serviceState);
        if (composeName) {
          await workspaceServicesService.teardownWorkspaceServices({
            composeProjectName: composeName,
            composeWorktreePath: ws.workingDir,
            releasedByWorkspaceId: ws.id,
          });
        }
        // #576: the devcontainer + dep volumes leak too, not just the compose stack.
        try {
          await reapWorkspaceContainer({ worktreePath: ws.workingDir, workspaceId: ws.id });
        } catch (err) {
          console.warn(`[projects] container reap failed (non-fatal) for ${ws.id}: ${errorMessage(err)}`);
        }
      }

      await deleteWorkspaceCascade(ws.id, database);
    }

    if (removedPath) {
      // #631: the delete path assumed `project.repoPath`, so the UI's cleanup action could
      // not reclaim a sibling worktree at all — they had to be removed by hand with
      // `git worktree remove` per repo. Resolve the OWNING repo from the path instead.
      const owner = await resolveOwningRepoPath(projectId, removedPath, project.repoPath, database);
      try { await removeWorktree(owner, removedPath); } catch { /* best effort */ }
    }
  }

  /**
   * Which repo's `git worktree remove` should be invoked for a worktree path (#631).
   *
   * Sibling worktrees live under `<sibling parent>/.worktrees/<repoDirName>/<branch>`, which
   * is NOT inside the leading repo — running `git worktree remove` from the leading repo just
   * fails ("is not a working tree"), silently, since the caller swallows it. Falls back to
   * the leading repo, which is both the old behaviour and the right answer for its own
   * worktrees.
   */
  async function resolveOwningRepoPath(
    projectId: string,
    worktreePath: string,
    leadingRepoPath: string,
    database: Database,
  ): Promise<string> {
    const claims = await getWorkspaceRepoClaims(projectId, database).catch(() => []);
    const target = worktreePath.replace(/\//g, sep).toLowerCase();
    const match = claims.find((c) => c.worktreePath?.replace(/\//g, sep).toLowerCase() === target);
    if (match?.repoPath) return match.repoPath;
    // No claim (an orphan): fall back to whichever registered repo the path sits under.
    const repos = await listProjectRepos(projectId, database).catch(() => []);
    const under = repos.find((r) => {
      const parent = r.path.replace(/\//g, sep).toLowerCase().split(sep).slice(0, -1).join(sep);
      return target.startsWith(parent + sep) && target.includes(`${sep}${r.path.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase()}${sep}`);
    });
    return under?.path ?? leadingRepoPath;
  }
  return { getWorktrees, removeWorktreeById };
}
