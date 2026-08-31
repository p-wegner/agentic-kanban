/**
 * Relocate a registered project to a new checkout path (#964).
 *
 * Moving a repo on disk had no board-side answer: `projects.repo_path` is deliberately
 * not writable through `updateProject`, so the only routes were unregister + re-register
 * (which cascades away every issue, workspace and session the project ever had) or a
 * hand-edit of the DB. Both were routinely wrong, because the repo path is not the only
 * absolute path the board persists — `repos.path`, `repos.worktree_path`,
 * `workspaces.working_dir` and the `projects_base_path` preference hold it too, and a
 * relocation that rewrites one of them leaves the rest pointing at a directory that is
 * no longer there.
 *
 * What is deliberately NOT rewritten: issue descriptions, comments, session stats and
 * artifacts. Those are a RECORD OF WHAT WAS TRUE at the time, not live pointers; editing
 * them would falsify history to make a `grep` come out clean.
 *
 * PLAN then APPLY. `planProjectRelocation` is a read that names every row it would touch
 * and every blocker it found; `relocateProject` runs the same plan and only writes if
 * there are no blockers. `dryRun` returns the plan and touches nothing — which is what
 * makes a multi-project migration reviewable before it happens.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { isPathInside, rewritePathPrefix, samePath } from "@agentic-kanban/shared/lib/path-key";
import { isAgentRunningStatus } from "@agentic-kanban/shared/lib/workspace-liveness";
import { db, withTransaction } from "../db/index.js";
import type { Database } from "../db/index.js";
import {
  getProjectById,
  getProjectsUnderPathPrefix,
  updateProjectRepoPath,
} from "../repositories/project.repository.js";
import {
  PROJECTS_BASE_PATH_KEY,
  getProjectScopedRepoPaths,
  getProjectWorkspacePaths,
  getProjectsBasePathPreference,
  getWorkspaceScopedRepoPaths,
  updatePreferenceValue,
  updateRepoPaths,
  updateWorkspaceWorkingDir,
} from "../repositories/project-relocate.repository.js";
import { ProjectError } from "./project-error.js";

/** One persisted path this relocation would rewrite. */
export interface RelocationChange {
  table: "projects" | "repos" | "workspaces" | "preferences";
  /** Row id, or the preference key. */
  id: string;
  column: string;
  from: string;
  to: string;
}

/** One directory this relocation would rename on disk (only when `moveFiles`). */
export interface RelocationDirectoryMove {
  from: string;
  to: string;
  kind: "repo" | "worktree";
}

export interface RelocationPlan {
  projectId: string;
  projectName: string;
  fromPath: string;
  toPath: string;
  changes: RelocationChange[];
  directoryMoves: RelocationDirectoryMove[];
  /**
   * Reasons this relocation must not proceed. A plan with blockers is still returned in
   * full — an operator needs to see WHAT would move as well as why it cannot yet.
   */
  blockers: string[];
}

export interface RelocationResult extends RelocationPlan {
  applied: boolean;
  dryRun: boolean;
  /** The repo `git worktree repair` was run in, with its verdict. */
  worktreeRepairs: { path: string; ok: boolean; detail?: string }[];
}

export interface RelocateOptions {
  /** Rename the directories on disk as part of the relocation. */
  moveFiles?: boolean;
  /** Report the plan and touch nothing. */
  dryRun?: boolean;
  /**
   * Rewrite `projects_base_path` when it pointed at the OLD parent directory. Defaults
   * to true: a base path aimed at a directory that no longer exists silently scaffolds
   * the next new project into a resurrected copy of the old tree.
   */
  updateBasePath?: boolean;
  /** Relocate even while one of the project's agents is running. */
  force?: boolean;
}

/** `<parent>/.worktrees` — the root the board parks a repo's worktrees under. */
function worktreeRootFor(repoPath: string): string {
  return join(dirname(repoPath), ".worktrees");
}

/**
 * Rewrite one persisted path for a relocation, or null if it is unaffected.
 *
 * Two prefixes matter, not one: a path inside the repo itself, and a path inside the
 * repo's `.worktrees` root — which is a SIBLING of the repo, so moving the repo alone
 * would strand it. The repo prefix is tried first because a repo that happens to sit
 * inside its own worktree root would otherwise be re-rooted by the wrong rule.
 */
function rewriteForRelocation(value: string, fromPath: string, toPath: string): string | null {
  const rewritten =
    rewritePathPrefix(value, fromPath, toPath) ??
    rewritePathPrefix(value, worktreeRootFor(fromPath), worktreeRootFor(toPath));
  // A path that re-roots onto itself is not a change. It happens for real — moving a repo
  // to a sibling directory leaves the shared `.worktrees` root exactly where it was — and
  // reporting it would pad the plan an operator reads with rows that need no write.
  return rewritten !== null && samePath(rewritten, value) ? null : rewritten;
}

function collectRepoRowChanges(
  repo: { id: string; path: string; worktreePath: string | null },
  fromPath: string,
  toPath: string,
  changes: RelocationChange[],
): void {
  const path = rewriteForRelocation(repo.path, fromPath, toPath);
  if (path) changes.push({ table: "repos", id: repo.id, column: "path", from: repo.path, to: path });
  if (repo.worktreePath) {
    const worktreePath = rewriteForRelocation(repo.worktreePath, fromPath, toPath);
    if (worktreePath) {
      changes.push({
        table: "repos",
        id: repo.id,
        column: "worktree_path",
        from: repo.worktreePath,
        to: worktreePath,
      });
    }
  }
}

export async function planProjectRelocation(
  projectId: string,
  newRepoPath: string,
  options: RelocateOptions = {},
  database: Database = db,
): Promise<RelocationPlan> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new ProjectError("Project not found", "NOT_FOUND");

  const fromPath = project.repoPath;
  const toPath = newRepoPath;
  const blockers: string[] = [];
  const changes: RelocationChange[] = [];
  const directoryMoves: RelocationDirectoryMove[] = [];

  if (samePath(fromPath, toPath)) {
    blockers.push(`Project "${project.name}" is already at ${toPath}`);
  } else if (isPathInside(toPath, fromPath) || isPathInside(fromPath, toPath)) {
    blockers.push(`Refusing to relocate a project into or out of itself (${fromPath} -> ${toPath})`);
  }

  if (options.moveFiles) {
    if (!existsSync(fromPath)) blockers.push(`Source directory does not exist: ${fromPath}`);
    if (existsSync(toPath)) blockers.push(`Destination already exists: ${toPath}`);
  } else if (!existsSync(join(toPath, ".git"))) {
    blockers.push(
      `Destination is not a git checkout: ${toPath} (pass moveFiles to have the board move it there)`,
    );
  }

  changes.push({ table: "projects", id: project.id, column: "repo_path", from: fromPath, to: toPath });
  if (options.moveFiles) directoryMoves.push({ from: fromPath, to: toPath, kind: "repo" });

  for (const repo of await getProjectScopedRepoPaths(project.id, database)) {
    collectRepoRowChanges(repo, fromPath, toPath, changes);
  }

  // Worktree directories, keyed by source path so a leaf named by both a workspace's
  // workingDir and its leading repos row is moved exactly once.
  const worktreeDirMoves = new Map<string, string>();
  for (const workspace of await getProjectWorkspacePaths(project.id, database)) {
    if (isAgentRunningStatus(workspace.status) && !options.force) {
      blockers.push(
        `Workspace ${workspace.id} (${workspace.branch}) has a running agent — stop it first, or pass force`,
      );
    }
    if (workspace.workingDir) {
      const to = rewriteForRelocation(workspace.workingDir, fromPath, toPath);
      if (to) {
        changes.push({
          table: "workspaces",
          id: workspace.id,
          column: "working_dir",
          from: workspace.workingDir,
          to,
        });
        if (!isPathInside(workspace.workingDir, fromPath)) worktreeDirMoves.set(workspace.workingDir, to);
      }
    }
    for (const repo of await getWorkspaceScopedRepoPaths(workspace.id, database)) {
      collectRepoRowChanges(repo, fromPath, toPath, changes);
      if (repo.worktreePath) {
        const to = rewriteForRelocation(repo.worktreePath, fromPath, toPath);
        if (to && !isPathInside(repo.worktreePath, fromPath)) worktreeDirMoves.set(repo.worktreePath, to);
      }
    }
  }

  if (options.moveFiles) {
    for (const [from, to] of worktreeDirMoves) {
      // A worktree the board recorded but that is already gone from disk needs no move —
      // the DB rewrite alone keeps the row consistent with where it WOULD be.
      if (existsSync(from)) directoryMoves.push({ from, to, kind: "worktree" });
    }
  }

  if (options.updateBasePath !== false) {
    const basePath = await getProjectsBasePathPreference(database);
    if (basePath && samePath(basePath, dirname(fromPath))) {
      changes.push({
        table: "preferences",
        id: PROJECTS_BASE_PATH_KEY,
        column: "value",
        from: basePath,
        to: dirname(toPath),
      });
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    fromPath,
    toPath,
    changes,
    directoryMoves,
    blockers,
  };
}

/**
 * Relink the moved worktrees to the moved repo. A git worktree stores ABSOLUTE paths on
 * both sides — `<worktree>/.git` names the repo's admin dir, and
 * `<repo>/.git/worktrees/<name>/gitdir` names the worktree — so a plain directory rename
 * leaves both broken. `git worktree repair <paths>` is the one command that fixes the
 * pair, and it must run from the repo's NEW location.
 */
async function repairWorktrees(plan: RelocationPlan): Promise<RelocationResult["worktreeRepairs"]> {
  if (!existsSync(plan.toPath)) return [];
  const worktreePaths = plan.directoryMoves.filter((m) => m.kind === "worktree").map((m) => m.to);
  const result = await gitExec(["worktree", "repair", ...worktreePaths], { cwd: plan.toPath });
  const ok = result.code === 0 && !result.error;
  return [{ path: plan.toPath, ok, detail: ok ? undefined : result.stderr || result.error?.message }];
}

export async function relocateProject(
  projectId: string,
  newRepoPath: string,
  options: RelocateOptions = {},
  database: Database = db,
): Promise<RelocationResult> {
  const plan = await planProjectRelocation(projectId, newRepoPath, options, database);
  if (plan.blockers.length > 0 || options.dryRun) {
    return { ...plan, applied: false, dryRun: !!options.dryRun, worktreeRepairs: [] };
  }

  // Disk first, DB second. If a rename fails the DB still describes reality; the
  // reverse order would leave rows pointing at a directory that was never created.
  for (const move of plan.directoryMoves) {
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
  }

  await withTransaction(
    database,
    async (tx) => {
      for (const change of plan.changes) {
        if (change.table === "projects") await updateProjectRepoPath(change.id, change.to, tx);
        else if (change.table === "workspaces") await updateWorkspaceWorkingDir(change.id, change.to, tx);
        else if (change.table === "preferences") await updatePreferenceValue(change.id, change.to, tx);
        else {
          await updateRepoPaths(
            change.id,
            change.column === "path" ? { path: change.to } : { worktreePath: change.to },
            tx,
          );
        }
      }
    },
    "relocateProject",
  );

  const worktreeRepairs = await repairWorktrees(plan);
  return { ...plan, applied: true, dryRun: false, worktreeRepairs };
}

export interface PrefixRelocationResult {
  fromPrefix: string;
  toPrefix: string;
  results: RelocationResult[];
  /**
   * The `projects_base_path` rewrite, if the preference pointed inside the old prefix.
   * Reported even on a dry run — a preview that silently omits a write it would perform
   * is the kind of report an operator stops trusting.
   */
  basePathChange?: RelocationChange;
}

/**
 * Relocate EVERY project under `fromPrefix` to the matching place under `toPrefix` —
 * the whole point of the feature for a directory consolidation, where doing it project
 * by project is both tedious and the thing that leaves one behind.
 *
 * Archived projects are included: an archived project's repo path is still a real
 * pointer, and skipping it is how a "the old directory is now empty" claim becomes false.
 */
export async function relocateProjectsUnderPrefix(
  fromPrefix: string,
  toPrefix: string,
  options: RelocateOptions = {},
  database: Database = db,
): Promise<PrefixRelocationResult> {
  const projects = await getProjectsUnderPathPrefix(fromPrefix, database);
  const results: RelocationResult[] = [];
  for (const project of projects) {
    const target = rewritePathPrefix(project.repoPath, fromPrefix, toPrefix);
    if (!target) continue;
    results.push(
      await relocateProject(
        project.id,
        target,
        // The base-path preference is a single global row: let it be decided once, below,
        // rather than rewritten to the same value once per project.
        { ...options, updateBasePath: false },
        database,
      ),
    );
  }

  let basePathChange: RelocationChange | undefined;
  if (options.updateBasePath !== false) {
    const basePath = await getProjectsBasePathPreference(database);
    const target = basePath ? rewritePathPrefix(basePath, fromPrefix, toPrefix) : null;
    if (basePath && target) {
      basePathChange = {
        table: "preferences",
        id: PROJECTS_BASE_PATH_KEY,
        column: "value",
        from: basePath,
        to: target,
      };
      if (!options.dryRun) await updatePreferenceValue(PROJECTS_BASE_PATH_KEY, target, database);
    }
  }

  return { fromPrefix, toPrefix, results, basePathChange };
}
