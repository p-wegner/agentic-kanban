import type { Command } from "commander";
import { db } from "../../db/index.js";
import { projects, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "../../services/git-info.service.js";
import { getCurrentBranch } from "../../services/git.service.js";
import { initializeProjectStatuses, DEFAULT_STATUSES } from "../../repositories/issue.repository.js";
import { runMigrations, logDefaultBranch } from "../shared.js";
import { getDefaultSkillId, ensureAgentGitignore, ensureStarterClaudeMd, ensureStarterAgentsMd, ensureHookScaffold, ensureVerifyGateRunner, commitProjectScaffoldArtifacts } from "../../services/project-scaffold.js";

/** Fall back to the repo's checked-out branch when main/master isn't detected, so the project is never left undriveable (#772). */
async function resolveCliDefaultBranch(repoPath: string, detected: string | null): Promise<string | null> {
  if (detected) return detected;
  try {
    const current = (await getCurrentBranch(repoPath)).trim();
    if (current && current !== "HEAD") return current;
  } catch { /* no commits / git unavailable */ }
  return null;
}

export function registerRegisterCommand(program: Command) {
  program
    .command("register")
    .description("Register a git repo as a project.\n\nAuto-detects repo name, default branch, and remote URL from the git repo at <path>. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as the active project.\n\nIf the repo is already registered (same path), it skips without error.")
    .argument("<path>", "Path to the git repository")
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban register .                 # register current directory
  $ agentic-kanban register /path/to/my-repo  # register a specific repo
  $ agentic-kanban register . --name "My App" # custom project name
`)
    .action(async (path: string, options: { name?: string }) => {
      try {
        await runMigrations();

        const repoInfo = await detectRepoInfo(path);
        const projectName = options.name || repoInfo.repoName;

        const existing = await db
          .select()
          .from(projects)
          .where(eq(projects.repoPath, repoInfo.repoPath))
          .limit(1);

        if (existing.length > 0) {
          console.log(`Project "${existing[0].name}" already registered at ${repoInfo.repoPath}`);
          process.exit(0);
        }

        const now = new Date().toISOString();
        const projectId = randomUUID();
        const defaultBranch = await resolveCliDefaultBranch(repoInfo.repoPath, repoInfo.defaultBranch);

        await db.insert(projects).values({
          id: projectId,
          name: projectName,
          repoPath: repoInfo.repoPath,
          repoName: repoInfo.repoName,
          defaultBranch,
          remoteUrl: repoInfo.remoteUrl,
          defaultSkillId: await getDefaultSkillId(),
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

        // Scaffold (clobber-safe): keep agent scratch out of history + drop a starter CLAUDE.md + hooks + verify-gate runner.
        ensureAgentGitignore(repoInfo.repoPath);
        ensureStarterClaudeMd(repoInfo.repoPath);
        ensureStarterAgentsMd(repoInfo.repoPath);
        ensureHookScaffold(repoInfo.repoPath);
        ensureVerifyGateRunner(repoInfo.repoPath);
        await commitProjectScaffoldArtifacts(repoInfo.repoPath);

        console.log(`Registered project "${projectName}"`);
        console.log(`  Repo: ${repoInfo.repoPath}`);
        logDefaultBranch(defaultBranch);
        if (repoInfo.remoteUrl) {
          console.log(`  Remote: ${repoInfo.remoteUrl}`);
        }
        console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
        console.log(`  Set as active project.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
