import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import type { Database } from "../db/index.js";
import { withTransaction } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getProjectWorkspacesWithIssue, updateProjectFields } from "../repositories/project-service.repository.js";
import { listProjectRepos, insertProjectRepo, deleteProjectRepo } from "../repositories/repo.repository.js";
import { ProjectError } from "./project-error.js";

const INITIAL_COMMIT_MESSAGE = "chore: initialise repository";

/**
 * Give a freshly `git init`ed repo its first commit, so HEAD is born (#47).
 *
 * Commits whatever the caller has written so far (a README, when requested) and falls back
 * to an empty commit. `--allow-empty` covers the no-README case; `add -A` runs before the
 * scaffold, so it can only ever pick up the caller's own file in a directory this service
 * just created. A machine with no `user.name`/`user.email` configured cannot commit at all,
 * so an identity is supplied for that case only — a configured identity still wins.
 *
 * This bootstrap commit is deliberately insulated from the user's global git config, because
 * unlike the scaffold commit (which is non-fatal and merely degrades) a failure here aborts
 * project creation and removes the directory. `commit.gpgsign=true` with no usable key, and a
 * global `core.hooksPath` pre-commit hook that rejects an empty/near-empty tree, are both
 * common enough that they would otherwise make createProject refuse to work at all — on a
 * commit whose only job is to give HEAD a parent.
 */
export function createInitialCommit(repoPath: string): void {
  gitExecSync(["add", "-A"], { cwd: repoPath, stdio: "pipe" });
  const commit = [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "--allow-empty",
    "-m",
    INITIAL_COMMIT_MESSAGE,
  ];
  try {
    gitExecSync(commit, { cwd: repoPath, stdio: "pipe" });
  } catch {
    gitExecSync(
      ["-c", "user.name=agentic-kanban", "-c", "user.email=agentic-kanban@localhost", ...commit],
      { cwd: repoPath, stdio: "pipe" },
    );
  }
}

/**
 * Scaffold a brand-new sibling git repo inside the project folder (beside the leading repo)
 * and return its absolute path. The `POST /:id/repos` `createName` mode calls this before
 * registering the result as an additional repo.
 *
 * Throws ProjectError (mapped to 400/404/409) on validation, existing-dir, or git failures.
 */
export async function createSiblingRepoDir(
  database: Database,
  projectId: string,
  opts: { name: string; generateReadme?: boolean },
): Promise<string> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
  const name = opts.name.trim();
  if (!name) throw new ProjectError("Repository name is required", "BAD_REQUEST");
  if (/[/\\<>:"|?*\x00]/.test(name)) {
    throw new ProjectError('Repository name contains invalid characters. Avoid: / \\ < > : " | ? *', "BAD_REQUEST");
  }
  const parent = dirname(project.repoPath);
  const targetPath = resolve(join(parent, name));
  if (existsSync(targetPath)) {
    throw new ProjectError(`Directory already exists: ${targetPath}. To add an existing repo, use "Local path" instead.`, "CONFLICT");
  }
  try {
    mkdirSync(targetPath, { recursive: true });
  } catch (err) {
    throw new ProjectError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
  }
  try {
    gitExecSync(["init"], { cwd: targetPath, stdio: "pipe" });
  } catch (err: unknown) {
    try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    throw new ProjectError(`git init failed: ${stderr ? String(stderr).trim() : String(err)}`, "BAD_REQUEST");
  }
  if (opts.generateReadme) {
    try { writeFileSync(join(targetPath, "README.md"), `# ${name}\n`, "utf8"); } catch { /* non-fatal */ }
  }
  try {
    createInitialCommit(targetPath);
  } catch (err) {
    try { rmSync(targetPath, { recursive: true, force: true }); } catch {}
    throw new ProjectError(`Failed to create the initial commit: ${err instanceof Error ? err.message : String(err)}`, "BAD_REQUEST");
  }
  return targetPath;
}

/**
 * Change WHICH repo leads a multi-repo project (#multirepo). "Leading" is not a flag
 * — it is which repo's identity sits on the project row (repoPath/repoName/defaultBranch/
 * setupScript) versus in the `repos` table. Promoting a sibling therefore SWAPS the two:
 * the project adopts the sibling's identity, the sibling's `repos` row is dropped, and the
 * former leading is demoted into a new sibling row. Atomic (all-or-nothing) so a mid-swap
 * failure can never leave the old leading unrecorded.
 *
 * Guarded against open workspaces: every workspace's worktrees are provisioned against the
 * CURRENT leading, so swapping while any are open would strand those worktrees against a repo
 * the project no longer considers leading. The caller must merge/close them first.
 */
export async function promoteRepoToLeading(database: Database, projectId: string, repoId: string) {
  const project = await getProjectById(projectId, database);
  if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
  const siblings = await listProjectRepos(projectId, database);
  const target = siblings.find((r) => r.id === repoId);
  if (!target) throw new ProjectError("Repo not found in this project", "NOT_FOUND");

  const openWorkspaces = (await getProjectWorkspacesWithIssue(projectId, database))
    .filter((w) => w.status !== "closed");
  if (openWorkspaces.length > 0) {
    throw new ProjectError(
      `Cannot change the leading repo while ${openWorkspaces.length} workspace(s) are open — their worktrees are tied to the current leading repo. Merge or delete them first.`,
      "CONFLICT",
    );
  }

  const baseName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;
  const newLeadingName = target.name ?? baseName(target.path);
  // Snapshot the current leading BEFORE the project row is overwritten, so it can be
  // re-inserted as a sibling. Its remoteUrl is the leading's own; the demoted sibling row
  // has no remoteUrl column, so that value is intentionally dropped (siblings track only
  // path/name/branch/setup/compose).
  const demoted = {
    path: project.repoPath,
    name: project.repoName,
    defaultBranch: project.defaultBranch,
    setupScript: project.setupScript,
  };

  await withTransaction(database, async (tx) => {
    await updateProjectFields(projectId, {
      repoPath: target.path,
      repoName: newLeadingName,
      defaultBranch: target.defaultBranch ?? null,
      setupScript: target.setupScript ?? null,
      // The old remote no longer describes the new leading; clear it rather than mislead.
      remoteUrl: null,
      updatedAt: new Date().toISOString(),
    }, tx);
    await deleteProjectRepo(repoId, projectId, tx);
    await insertProjectRepo({
      projectId,
      path: demoted.path,
      name: demoted.name,
      defaultBranch: demoted.defaultBranch,
      setupScript: demoted.setupScript,
      composeFile: null,
    }, tx);
  }, "promoteRepoToLeading");

  return { id: projectId, repoName: newLeadingName };
}
