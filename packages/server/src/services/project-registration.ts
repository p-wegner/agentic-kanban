import { db } from "../db/index.js";
import { projects, projectStatuses, preferences, issues, agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectRepoInfo } from "./git-info.service.js";

const execFileAsync = promisify(execFile);

async function tryGetGitRoot(repoPath: string): Promise<string | null> {
  try {
    const out = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: repoPath, timeout: 5000 });
    return resolve(out.stdout.trim());
  } catch {
    return null;
  }
}

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

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

      // Move issues to the surviving project
      await db.update(issues).set({ projectId: keep.id }).where(eq(issues.projectId, dup.id));
      // Move project-scoped skills to the surviving project
      await db.update(agentSkills).set({ projectId: keep.id }).where(eq(agentSkills.projectId, dup.id));
      // Remove duplicate's statuses
      await db.delete(projectStatuses).where(eq(projectStatuses.projectId, dup.id));
      // Remove duplicate project
      await db.delete(projects).where(eq(projects.id, dup.id));

      // If activeProjectId pointed to the removed project, redirect it to the survivor
      const activePref = await db
        .select()
        .from(preferences)
        .where(eq(preferences.key, "activeProjectId"))
        .limit(1);
      if (activePref[0]?.value === dup.id) {
        const now = new Date().toISOString();
        await db
          .insert(preferences)
          .values({ key: "activeProjectId", value: keep.id, updatedAt: now })
          .onConflictDoUpdate({ target: preferences.key, set: { value: keep.id, updatedAt: now } });
      }
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

  await db.insert(projects).values({
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch: repoInfo.defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    createdAt: now,
    updatedAt: now,
  });

  for (const status of DEFAULT_STATUSES) {
    await db.insert(projectStatuses).values({
      id: randomUUID(),
      projectId,
      name: status.name,
      sortOrder: status.sortOrder,
      isDefault: status.isDefault,
      createdAt: now,
    });
  }

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

  const project = {
    id: projectId,
    name: projectName,
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    defaultBranch: repoInfo.defaultBranch,
    remoteUrl: repoInfo.remoteUrl,
    createdAt: now,
    updatedAt: now,
  };

  return { project, created: true };
}
