import { db } from "../db/index.js";
import { projects, projectStatuses, preferences, issues, agentSkills, repos, scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectRepoInfo } from "./git-info.service.js";
import { initializeProjectStatuses } from "../repositories/issue.repository.js";
import { getCurrentBranch } from "./git.service.js";
import { populateStackProfile, getStackProfile } from "./stack-profile.service.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve a non-null default branch for a freshly-registered repo.
 *
 * detectRepoInfo() only finds a local `main`/`master`; a repo whose default branch
 * is named anything else returns null, which later makes `POST /api/workspaces`
 * 400 "No default branch configured" and the monitor's auto-start swallow it
 * silently (#772). Fall back to the repo's actually checked-out branch.
 */
async function resolveDefaultBranch(
  repoPath: string,
  detected: string | null,
): Promise<string | null> {
  if (detected) return detected;
  try {
    const current = (await getCurrentBranch(repoPath)).trim();
    // "HEAD" means detached; not a usable branch name.
    if (current && current !== "HEAD") return current;
  } catch {
    // git unavailable / no commits yet — leave null, caller warns.
  }
  return null;
}

async function tryGetGitRoot(repoPath: string): Promise<string | null> {
  try {
    const out = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, timeout: 5000 });
    return resolve(out.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Detects and removes duplicate project registrations caused by registering a subdirectory
 * of a git repo before git-root resolution was added to detectRepoInfo.
 *
 * Groups all projects by their resolved git root. When multiple projects share the same
 * git root, keeps the one with repoPath == gitRoot (or the most recently updated), moves
 * any issues/skills to the survivor, and deletes the duplicates.
 */
export async function deduplicateProjects(): Promise<void> {
  const allProjects = await db.select().from(projects);
  if (allProjects.length <= 1) return;

  // Map gitRoot → projects that resolve to it
  const byGitRoot = new Map<string, typeof allProjects>();
  for (const project of allProjects) {
    const gitRoot = await tryGetGitRoot(project.repoPath);
    if (!gitRoot) continue; // can't resolve — skip
    const group = byGitRoot.get(gitRoot) ?? [];
    group.push(project);
    byGitRoot.set(gitRoot, group);
  }

  for (const [gitRoot, group] of byGitRoot) {
    if (group.length <= 1) continue;

    // Prefer the project whose repoPath already equals the git root;
    // break ties by updatedAt (most recent wins).
    const sorted = [...group].sort((a, b) => {
      const aIsRoot = a.repoPath === gitRoot ? 1 : 0;
      const bIsRoot = b.repoPath === gitRoot ? 1 : 0;
      if (aIsRoot !== bIsRoot) return bIsRoot - aIsRoot;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    const [keep, ...remove] = sorted;
    for (const dup of remove) {
      console.log(
        `[startup] Removing duplicate project "${dup.name}" (${dup.repoPath}) ` +
        `— same git repo as "${keep.name}" (${keep.repoPath})`
      );

      await db.transaction(async (tx) => {
        // Remap issue statusIds to the surviving project's statuses (matched by name)
        const dupStatuses = await tx.select().from(projectStatuses).where(eq(projectStatuses.projectId, dup.id));
        const keepStatuses = await tx.select().from(projectStatuses).where(eq(projectStatuses.projectId, keep.id));
        for (const dupStatus of dupStatuses) {
          const match = keepStatuses.find((s) => s.name === dupStatus.name);
          if (match && match.id !== dupStatus.id) {
            await tx.update(issues)
              .set({ statusId: match.id })
              .where(and(eq(issues.projectId, dup.id), eq(issues.statusId, dupStatus.id)));
          }
        }

        // Move issues to the surviving project
        await tx.update(issues).set({ projectId: keep.id }).where(eq(issues.projectId, dup.id));
        // Move project-scoped skills to the surviving project
        await tx.update(agentSkills).set({ projectId: keep.id }).where(eq(agentSkills.projectId, dup.id));
        // Move repos to the surviving project
        await tx.update(repos).set({ projectId: keep.id }).where(eq(repos.projectId, dup.id));
        // Move scheduled runs to the surviving project
        await tx.update(scheduledRuns).set({ projectId: keep.id }).where(eq(scheduledRuns.projectId, dup.id));
        // Remove duplicate's statuses
        await tx.delete(projectStatuses).where(eq(projectStatuses.projectId, dup.id));
        // Remove duplicate project
        await tx.delete(projects).where(eq(projects.id, dup.id));

        // If activeProjectId pointed to the removed project, redirect it to the survivor
        const activePref = await tx
          .select()
          .from(preferences)
          .where(eq(preferences.key, "activeProjectId"))
          .limit(1);
        if (activePref[0]?.value === dup.id) {
          const now = new Date().toISOString();
          await tx
            .insert(preferences)
            .values({ key: "activeProjectId", value: keep.id, updatedAt: now })
            .onConflictDoUpdate({ target: preferences.key, set: { value: keep.id, updatedAt: now } });
        }
      });
    }

    // If the surviving project still has a non-root repoPath, update it to the git root
    if (keep.repoPath !== gitRoot) {
      await db
        .update(projects)
        .set({ repoPath: gitRoot, repoName: basename(gitRoot), updatedAt: new Date().toISOString() })
        .where(eq(projects.id, keep.id));
    }
  }
}

export async function registerProject(path: string, options?: { name?: string }) {
  const repoInfo = await detectRepoInfo(path);
  const projectName = options?.name || repoInfo.repoName;

  // Check for an existing project at the exact git root, or one whose stored path
  // resolves to the same git root (handles legacy subdirectory registrations).
  const allProjects = await db.select().from(projects);
  const existing = allProjects.find((p) => p.repoPath === repoInfo.repoPath) ??
    (await (async () => {
      for (const p of allProjects) {
        const root = await tryGetGitRoot(p.repoPath);
        if (root === repoInfo.repoPath) return p;
      }
      return undefined;
    })());

  if (existing) {
    return { project: existing, created: false };
  }

  const now = new Date().toISOString();
  const projectId = randomUUID();

  // Never leave defaultBranch null — that makes the project undriveable (#772).
  const defaultBranch = await resolveDefaultBranch(repoInfo.repoPath, repoInfo.defaultBranch);

  // Default skill so a freshly-registered project's worktrees aren't skill-less:
  // board-navigator teaches the agent how to use the board (MCP/CLI, reflect progress).
  // Without this, resolveSkillFile writes NO skill into a new project's worktree and the
  // Builder works blind. Falls back to null gracefully if the builtin isn't seeded. (#531)
  const [navSkill] = await db.select({ id: agentSkills.id }).from(agentSkills)
    .where(eq(agentSkills.name, "board-navigator")).limit(1);
  const defaultSkillId = navSkill?.id ?? null;

  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    defaultSkillId,
    createdAt: now,
    updatedAt: now,
  });

  // Canonical 7-status set (incl. Backlog at -1) so auto-driven Backlog-pull works (#772).
  await initializeProjectStatuses(projectId, now);

  await db
    .insert(preferences)
    .values({
      key: "activeProjectId",
      value: projectId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: preferences.key,
      set: { value: projectId, updatedAt: now },
    });

  // Durable stack profile (#786): the ONE descriptor the feedback harness reads.
  // Best-effort & non-blocking — the optional LLM gap-fill must not slow or fail registration.
  void populateStackProfile(projectId, repoInfo.repoPath, db).catch(() => { /* non-fatal */ });

  const project = {
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    defaultSkillId,
    createdAt: now,
    updatedAt: now,
  };

  return { project, created: true };
}

/**
 * Backfill a driveable state onto an already-registered project (#772):
 *  - seed the canonical default status set if the project has none
 *    (missing statuses make `POST /api/issues/batch` 400 "No statuses found");
 *  - set defaultBranch from the repo's current branch if it is null
 *    (a null branch makes `POST /api/workspaces` 400 "No default branch configured").
 *
 * Idempotent: existing statuses are left untouched and a non-null branch is preserved.
 * Returns what (if anything) was repaired.
 */
export async function repairProjectRegistration(
  projectId: string,
): Promise<{ seededStatuses: boolean; setDefaultBranch: string | null; populatedStackProfile: boolean }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const now = new Date().toISOString();
  let seededStatuses = false;
  let setDefaultBranch: string | null = null;
  let populatedStackProfile = false;

  const existingStatuses = await db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .limit(1);
  if (existingStatuses.length === 0) {
    await initializeProjectStatuses(projectId, now);
    seededStatuses = true;
  }

  if (!project.defaultBranch) {
    const branch = await resolveDefaultBranch(project.repoPath, null);
    if (branch) {
      await db
        .update(projects)
        .set({ defaultBranch: branch, updatedAt: now })
        .where(eq(projects.id, projectId));
      setDefaultBranch = branch;
    }
  }

  // Backfill the stack profile (#786) onto a project registered before profiles existed.
  // Idempotent: only computes when none is persisted yet.
  const existingProfile = await getStackProfile(projectId, db);
  if (!existingProfile) {
    try {
      await populateStackProfile(projectId, project.repoPath, db);
      populatedStackProfile = true;
    } catch {
      // non-fatal — leave unpopulated, a later repair/registration can retry.
    }
  }

  return { seededStatuses, setDefaultBranch, populatedStackProfile };
}
